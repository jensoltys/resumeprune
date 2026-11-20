// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
import { res, readJson, nowSec, uuid, requireSameOrigin, aiReady, aiNotSetUp, aiFailure } from '../helpers.js';
import { requireAuth } from '../auth.js';
import { rateLimit } from '../ratelimit.js';
import { callClaude, parseJsonFromText, HAIKU_FIRST_CHAIN, SONNET_FIRST_CHAIN } from '../anthropic.js';
import { ANALYZE_PROMPT, TAILOR_PROMPT, COVER_PROMPT } from '../prompts.js';
import { analyzeUserMsg, tailorUserMsg } from '../lib/prompt-messages.js';
import { scrubVoice, normalizeCover } from '../lib/output-scrub.js';
import { periodKeyFor, planLimit, isUnderLimit, effectivePlan } from '../lib/usage.js';
import { loadGapFills } from './gapfill-routes.js';
import { resumeChecks } from '../lib/resume-checks.js';

// Heuristic: pull a usable display label out of a job description when the user
// didn't bother filling in the role title. Returns a short string (≤70 chars).
// Tries common JD patterns first, falls back to a clean prefix of the JD.
function deriveRoleFromJd(jd) {
  if (!jd) return 'Untitled role';
  const text = String(jd).replace(/\s+/g, ' ').trim();
  // Pattern: "We're hiring a Senior Software Engineer ..." / "Hiring an Account Executive"
  const hiring = text.match(/\b(?:hiring|seeking|looking for|recruiting)\s+(?:an?\s+)?([A-Z][\w\-\/ ]{2,60}?)(?:\s+(?:to|who|with|at|in|for|that|on|\.|,|;)|$)/i);
  if (hiring && hiring[1]) return hiring[1].trim().slice(0, 70);
  // Pattern: "Position: Senior Software Engineer" / "Role: Account Executive"
  const labeled = text.match(/(?:position|role|job title|title)\s*[:\-]\s*([A-Z][\w\-\/ ]{2,60}?)(?:\s+(?:at|in|for|\.|,|;|\n)|$)/i);
  if (labeled && labeled[1]) return labeled[1].trim().slice(0, 70);
  // First non-empty line if it's title-shaped: ≤70 chars, starts capital, no terminal period
  const firstLine = String(jd).split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
  if (firstLine.length > 0 && firstLine.length <= 70 && /^[A-Z]/.test(firstLine) && !/\.$/.test(firstLine)) {
    return firstLine;
  }
  // Fallback: clean prefix of the JD, broken at a word boundary
  const prefix = text.slice(0, 60);
  const lastSpace = prefix.lastIndexOf(' ');
  return (lastSpace > 30 ? prefix.slice(0, lastSpace) : prefix) + '…';
}

// Plan check + atomic usage-slot claim, shared by analyze and a paid re-check.
// Returns { limit, periodKey, refundSlot }; throws NO_PLAN / LIMIT_REACHED responses.
// Target role/industry from onboarding step 4, fed into the match check.
async function loadTarget(env, uid) {
  const row = await env.DB.prepare(`SELECT target_role, target_industry FROM users WHERE id = ?`).bind(uid).first();
  return { role: row?.target_role || '', industry: row?.target_industry || '' };
}

async function claimTweakSlot(env, uid) {
  // Plan + counter check.
  const user = await env.DB.prepare(`SELECT plan, plan_expires, stripe_subscription_id FROM users WHERE id = ?`).bind(uid).first();
  if (!user) throw res({ error: 'User not found' }, 404);
  // effectivePlan honors gift expiry for non-paying users; paying customers
  // (stripe_subscription_id present) keep their exact Stripe-managed plan.
  const plan = effectivePlan(user, env);
  const limit = planLimit(plan);
  if (limit === 0) {
    throw res({
      error: 'Pro tweaks are for paid plans. Pick a paid plan to start tweaking.',
      code: 'NO_PLAN',
    }, 402);
  }

  const periodKey = periodKeyFor(plan);

  // ATOMIC SLOT CLAIM (race-safe against concurrent double-clicks):
  // 1. INSERT OR IGNORE creates the counter row at 0 if missing.
  // 2. UPDATE conditionally increments only when current value is below limit.
  // If the UPDATE matches 0 rows, the slot was already taken — return 429.
  // This replaces the previous SELECT-then-UPSERT flow which had a TOCTOU window.
  const claimResult = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO usage_counters (uid, period_key, tweaks_used) VALUES (?, ?, 0)`
    ).bind(uid, periodKey),
    env.DB.prepare(
      `UPDATE usage_counters SET tweaks_used = tweaks_used + 1
       WHERE uid = ? AND period_key = ? AND tweaks_used < ?`
    ).bind(uid, periodKey, limit),
  ]);
  const claimChanges = claimResult[1]?.meta?.changes || 0;
  if (claimChanges === 0) {
    const cur = await env.DB.prepare(
      `SELECT tweaks_used FROM usage_counters WHERE uid = ? AND period_key = ?`
    ).bind(uid, periodKey).first();
    const used = cur?.tweaks_used || 0;
    const resetCopy = plan === 'sprint'
      ? 'Your weekly Sprint allowance refreshes Monday.' // ISO week, see periodKeyFor in lib/usage.js
      : 'Your monthly Pro allowance refreshes on the 1st.';
    // Retry-After is approximate — actual reset is end of billing period.
    // 3600 prevents clients from hammering; the frontend should show resetCopy.
    throw res({
      error: `You've used all ${limit} tweaks this period. ${resetCopy}`,
      code: 'LIMIT_REACHED',
      tweaks_used: used,
      tweaks_limit: limit,
      retry_after: 3600,
    }, 429, { 'Retry-After': '3600' });
  }

  // Helper: refund the slot if anything below this point fails (no resume,
  // Claude error, parse failure, etc.). Guarded so the counter never goes
  // negative under concurrent refunds.
  const refundSlot = async () => {
    await env.DB.prepare(
      `UPDATE usage_counters SET tweaks_used = tweaks_used - 1
       WHERE uid = ? AND period_key = ? AND tweaks_used > 0`
    ).bind(uid, periodKey).run();
  };
  return { limit, periodKey, refundSlot };
}

// POST /api/tweak/analyze
export async function tweakAnalyze(request, env) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const uid = await requireAuth(request, env);
  // Per-user burst cap: 10 analyses / 60s. Plan-quota gating handles total
  // monthly/weekly cost; this catches automation/abuse where someone spams
  // the endpoint. Keyed by user id, not IP, so a real user behind a shared
  // IP isn't punished for someone else's bad behavior.
  const burstBlock = await rateLimit(request, env, 'tweak-analyze', 10, 60, `uid:${uid}:tweak-analyze`);
  if (burstBlock) return burstBlock;
  const body = await readJson(request);

  const jd = typeof body.jobDescription === 'string' ? body.jobDescription.trim() : '';
  const roleTitle = typeof body.roleTitle === 'string' ? body.roleTitle.slice(0, 200).trim() : null;
  const companyName = typeof body.companyName === 'string' ? body.companyName.slice(0, 200).trim() : null;

  if (jd.length < 50)    throw res({ error: 'Job description seems too short. Paste at least a paragraph.' }, 400);
  if (jd.length > 12000) throw res({ error: 'Job description is too long (max 12,000 characters).' }, 400);

  if (!aiReady(env)) return aiNotSetUp(); // before a tweak is spent
  const { limit, periodKey, refundSlot } = await claimTweakSlot(env, uid);

  // Resume must exist (single query for both columns).
  const resumeRow = await env.DB.prepare(
    `SELECT parsed_json, raw_text FROM resumes WHERE uid = ?`
  ).bind(uid).first();
  if (!resumeRow) {
    await refundSlot();
    throw res({ error: 'Upload your base resume first.', code: 'NO_RESUME' }, 412);
  }
  let parsedResume;
  try { parsedResume = JSON.parse(resumeRow.parsed_json); }
  catch {
    await refundSlot();
    throw res({ error: 'Stored resume is corrupt. Re-upload from /onboarding.' }, 500);
  }
  const rawText = resumeRow.raw_text || '';

  // Reuse the same analyzeUserMsg the free flow uses so the prompt input
  // shape never drifts between the two flows. Gap fills (user-confirmed
  // experience not on the base resume) ride along so covered requirements
  // stop showing up as gaps.
  const gapFills = await loadGapFills(env, uid);
  const target = await loadTarget(env, uid);
  let analyzeResp;
  try {
    analyzeResp = await callClaude(env, {
      system: ANALYZE_PROMPT.system,
      userMessage: analyzeUserMsg({ resumeText: rawText, jd, roleTitle, companyName, gapFills, target }),
      maxTokens: ANALYZE_PROMPT.maxTokens || 1500,
      models: HAIKU_FIRST_CHAIN,
    });
  } catch (e) {
    await refundSlot();
    throw aiFailure(e, 'Analysis temporarily unavailable. Try again in a minute.', 'tweak/analyze');
  }
  const analysis = parseJsonFromText(analyzeResp.text);
  if (!analysis) {
    await refundSlot();
    throw res({ error: 'Could not parse analysis output.' }, 502);
  }

  // Create tweak row. Counter was already incremented in the slot claim.
  // If the user didn't provide a role_title, derive one from the JD so the
  // history sidebar doesn't fill up with "Untitled role".
  const displayRoleTitle = roleTitle || deriveRoleFromJd(jd);
  const tweakId = uuid();
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO tweaks (id, uid, jd, role_title, company_name, analysis_json, model_used, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(tweakId, uid, jd, displayRoleTitle, companyName, JSON.stringify(analysis), analyzeResp.modelUsed, now).run();

  // After the increment, used became (previous + 1). Compute remaining.
  const usedAfter = (await env.DB.prepare(
    `SELECT tweaks_used FROM usage_counters WHERE uid = ? AND period_key = ?`
  ).bind(uid, periodKey).first())?.tweaks_used || 0;

  return res({
    tweakId,
    analysis,
    parsedResume, // returned so the frontend can keep going to generate without re-fetch
    resumeChecks: resumeChecks(parsedResume, resumeRow.raw_text, jd),
    tweaksRemaining: Math.max(0, limit - usedAfter),
  });
}

// POST /api/tweak/generate
export async function tweakGenerate(request, env) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const uid = await requireAuth(request, env);
  // Per-user burst cap: 20 generates / 60s. Generate is idempotent (cached
  // returns are free) but we still want to bound total Claude calls.
  const burstBlock = await rateLimit(request, env, 'tweak-generate', 20, 60, `uid:${uid}:tweak-generate`);
  if (burstBlock) return burstBlock;
  const body = await readJson(request);

  const tweakId = typeof body.tweakId === 'string' ? body.tweakId : '';
  const mode = body.mode === 'cover' ? 'cover' : body.mode === 'resume' ? 'resume' : null;
  if (!tweakId) throw res({ error: 'tweakId is required.' }, 400);
  if (!mode)    throw res({ error: 'mode must be "resume" or "cover".' }, 400);

  const tweak = await env.DB.prepare(
    `SELECT id, uid, jd, role_title, company_name, resume_json, cover_json
     FROM tweaks WHERE id = ?`
  ).bind(tweakId).first();
  if (!tweak || tweak.uid !== uid) throw res({ error: 'Tweak not found.' }, 404);

  // Idempotent: if already generated, return what we have.
  if (mode === 'resume' && tweak.resume_json) {
    return res({ resume: JSON.parse(tweak.resume_json), cached: true });
  }
  if (mode === 'cover' && tweak.cover_json) {
    return res({ cover: JSON.parse(tweak.cover_json), cached: true });
  }

  if (!aiReady(env)) return aiNotSetUp();
  // Past this point it's a real AI call, so it gets a daily ceiling per user.
  const dayBlock = await rateLimit(request, env, 'tweak-generate-day', 60, 24 * 3600, `uid:${uid}:tweak-generate-day`);
  if (dayBlock) return dayBlock;

  // Need parsed resume for prompt context.
  const resumeRow = await env.DB.prepare(
    `SELECT parsed_json FROM resumes WHERE uid = ?`
  ).bind(uid).first();
  if (!resumeRow) throw res({ error: 'Base resume missing. Re-upload from /onboarding.' }, 412);
  let parsedResume;
  try { parsedResume = JSON.parse(resumeRow.parsed_json); }
  catch { throw res({ error: 'Stored resume is corrupt.' }, 500); }

  // TAILOR_PROMPT and COVER_PROMPT both consume the same `tailorUserMsg` shape
  // (parsedResume + JD + roleTitle/companyName) — see sample-routes.js.
  const promptDef = mode === 'resume' ? TAILOR_PROMPT : COVER_PROMPT;
  const chain = mode === 'resume' ? SONNET_FIRST_CHAIN : HAIKU_FIRST_CHAIN;

  // Saved gap fills feed generation too, so a rerun after filling a gap can
  // actually use the new material.
  const gapFills = await loadGapFills(env, uid);
  let claudeResp;
  try {
    claudeResp = await callClaude(env, {
      system: promptDef.system,
      userMessage: tailorUserMsg({
        parsedResume,
        jd: tweak.jd,
        roleTitle: tweak.role_title,
        companyName: tweak.company_name,
        gapFills,
      }),
      maxTokens: promptDef.maxTokens || (mode === 'resume' ? 4000 : 1200),
      models: chain,
    });
  } catch (e) {
    throw aiFailure(e, `${mode === 'resume' ? 'Tailor' : 'Cover'} generation temporarily unavailable. Try again in a minute.`, `tweak/generate(${mode})`);
  }
  let output = scrubVoice(parseJsonFromText(claudeResp.text));
  if (!output) {
    // Metadata only — never log raw model output, it may contain user resume content (PII).
    const txt = claudeResp.text || '';
    console.error(`tweak/generate(${mode}) parse failed. modelUsed=${claudeResp.modelUsed} stop=${claudeResp.stopReason} length=${txt.length} uid=${uid} tweakId=${tweakId}`);
    throw res({ error: 'Could not parse generation output.' }, 502);
  }
  // Cover-only structural normalization: enforce 3 paragraphs, lift signoff
  // out of the paragraphs array if the model put it there.
  if (mode === 'cover') output = normalizeCover(output);

  const json = JSON.stringify(output);
  const col = mode === 'resume' ? 'resume_json' : 'cover_json';
  await env.DB.prepare(
    `UPDATE tweaks SET ${col} = ?, model_used = COALESCE(model_used, ?) WHERE id = ?`
  ).bind(json, claudeResp.modelUsed, tweakId).run();

  if (mode === 'resume') return res({ resume: output, cached: false });
  return res({ cover: output, cached: false });
}

// The match score inside analysis_json (match_score, or score on older rows). json_valid
// guards the odd malformed row, which would otherwise make json_extract fail the whole query.
const SCORE_SQL = `CASE WHEN json_valid(analysis_json)
  THEN COALESCE(json_extract(analysis_json, '$.match_score'), json_extract(analysis_json, '$.score')) END`;

// GET /api/tweaks?limit=20&offset=0
export async function tweakList(request, env) {
  const uid = await requireAuth(request, env);
  const url = new URL(request.url);
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);

  const { results } = await env.DB.prepare(
    `SELECT id, role_title, company_name, created_at, app_status, status_updated_at,
            ${SCORE_SQL} AS score,
            (resume_json IS NOT NULL) AS has_resume,
            (cover_json IS NOT NULL)  AS has_cover
     FROM tweaks
     WHERE uid = ?
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(uid, limit, offset).all();

  // Average match score for tweaks made this calendar month (UTC), for the sidebar header.
  const d = new Date();
  const monthStart = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
  const avg = await env.DB.prepare(
    `SELECT AVG(${SCORE_SQL}) AS avg, COUNT(${SCORE_SQL}) AS n FROM tweaks WHERE uid = ? AND created_at >= ?`
  ).bind(uid, monthStart).first();

  return res({
    tweaks: (results || []).map(r => ({
      id: r.id,
      role_title: r.role_title || '',
      company_name: r.company_name || '',
      created_at: r.created_at,
      app_status: r.app_status || 'tweaked',
      status_updated_at: r.status_updated_at || null,
      score: r.score == null ? null : Number(r.score),
      has_resume: !!r.has_resume,
      has_cover: !!r.has_cover,
    })),
    month_avg: avg && avg.n ? Math.round(avg.avg * 10) / 10 : null,
    month_scored: avg ? avg.n : 0,
    limit, offset,
  });
}

// PATCH /api/tweaks/:id  body: { app_status }
// Job-hunt tracker: move an application through tweaked -> applied ->
// interviewing -> offer (or closed). Whitelisted values only.
const APP_STATUSES = ['tweaked', 'applied', 'interviewing', 'offer', 'closed'];
export async function tweakSetStatus(request, env, tweakId) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const uid = await requireAuth(request, env);
  const body = await readJson(request);
  const status = String(body.app_status || '');
  if (!APP_STATUSES.includes(status)) {
    throw res({ error: `app_status must be one of: ${APP_STATUSES.join(', ')}.` }, 400);
  }
  const t = await env.DB.prepare(`SELECT uid FROM tweaks WHERE id = ?`).bind(tweakId).first();
  if (!t || t.uid !== uid) throw res({ error: 'Tweak not found.' }, 404);
  const now = nowSec();
  await env.DB.prepare(`UPDATE tweaks SET app_status = ?, status_updated_at = ? WHERE id = ?`).bind(status, now, tweakId).run();
  return res({ ok: true, app_status: status, status_updated_at: now });
}

// GET /api/tweaks/:id
export async function tweakDetail(request, env, tweakId) {
  const uid = await requireAuth(request, env);
  const t = await env.DB.prepare(
    `SELECT id, uid, jd, role_title, company_name, analysis_json, resume_json, cover_json, model_used, created_at, rescores
     FROM tweaks WHERE id = ?`
  ).bind(tweakId).first();
  if (!t || t.uid !== uid) throw res({ error: 'Tweak not found.' }, 404);

  return res({
    tweak: {
      id: t.id,
      jd: t.jd,
      role_title: t.role_title || '',
      company_name: t.company_name || '',
      analysis: t.analysis_json ? JSON.parse(t.analysis_json) : null,
      resume:   t.resume_json   ? JSON.parse(t.resume_json)   : null,
      cover:    t.cover_json    ? JSON.parse(t.cover_json)    : null,
      model_used: t.model_used,
      created_at: t.created_at,
      rescores: t.rescores || 0,
    },
  });
}

// DELETE /api/tweaks/:id
export async function tweakDelete(request, env, tweakId) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const uid = await requireAuth(request, env);
  const t = await env.DB.prepare(`SELECT uid FROM tweaks WHERE id = ?`).bind(tweakId).first();
  if (!t || t.uid !== uid) throw res({ error: 'Tweak not found.' }, 404);
  await env.DB.prepare(`DELETE FROM tweaks WHERE id = ?`).bind(tweakId).run();
  return res({ ok: true });
}

// POST /api/tweaks/:id/rescore
// Re-runs the match check on an existing tweak so a new gap fill counts toward its score.
// The FIRST re-check on a tweak is free;
// every later one spends a tweak exactly like a new check. Only the analysis changes:
// resume_json stays put, because a published /r/ page reads it live.
export async function tweakRescore(request, env, tweakId) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const uid = await requireAuth(request, env);
  if (!aiReady(env)) return aiNotSetUp();
  const burstBlock = await rateLimit(request, env, 'tweak-rescore', 5, 60, `uid:${uid}:tweak-rescore`);
  if (burstBlock) return burstBlock;
  // Daily ceiling on AI calls from re-checks: a failed parse refunds the
  // free re-check, so without a cap a crafted gap fill could loop paid Claude calls.
  const dayBlock = await rateLimit(request, env, 'tweak-rescore-day', 30, 24 * 3600, `uid:${uid}:tweak-rescore-day`);
  if (dayBlock) return dayBlock;

  const t = await env.DB.prepare(
    `SELECT uid, jd, role_title, company_name FROM tweaks WHERE id = ?`
  ).bind(tweakId).first();
  if (!t || t.uid !== uid) throw res({ error: 'Tweak not found.' }, 404);

  // Even the free re-check needs an active plan, same as a new check (a lapsed plan keeps old tweaks).
  const user = await env.DB.prepare(`SELECT plan, plan_expires, stripe_subscription_id FROM users WHERE id = ?`).bind(uid).first();
  if (!user || planLimit(effectivePlan(user, env)) === 0) {
    throw res({
      error: 'Re-checks are for paid plans. Pick a paid plan to keep tweaking.',
      code: 'NO_PLAN',
    }, 402);
  }

  // Claim the free re-check atomically, so two quick clicks can't both get it.
  const freeClaim = await env.DB.prepare(
    `UPDATE tweaks SET rescores = rescores + 1 WHERE id = ? AND rescores = 0`
  ).bind(tweakId).run();
  const free = (freeClaim.meta?.changes || 0) === 1;
  let refund;
  if (free) {
    refund = async () => {
      await env.DB.prepare(`UPDATE tweaks SET rescores = 0 WHERE id = ? AND rescores = 1`).bind(tweakId).run();
    };
  } else {
    const slot = await claimTweakSlot(env, uid);
    refund = slot.refundSlot;
    await env.DB.prepare(`UPDATE tweaks SET rescores = rescores + 1 WHERE id = ?`).bind(tweakId).run();
  }

  const resumeRow = await env.DB.prepare(`SELECT raw_text FROM resumes WHERE uid = ?`).bind(uid).first();
  if (!resumeRow) {
    await refund();
    throw res({ error: 'Upload your base resume first.', code: 'NO_RESUME' }, 412);
  }
  const gapFills = await loadGapFills(env, uid);
  const target = await loadTarget(env, uid);
  let resp;
  try {
    resp = await callClaude(env, {
      system: ANALYZE_PROMPT.system,
      userMessage: analyzeUserMsg({
        resumeText: resumeRow.raw_text || '', jd: t.jd, roleTitle: t.role_title, companyName: t.company_name, gapFills, target,
      }),
      maxTokens: ANALYZE_PROMPT.maxTokens || 1500,
      models: HAIKU_FIRST_CHAIN,
    });
  } catch (e) {
    await refund();
    throw aiFailure(e, 'Analysis temporarily unavailable. Try again in a minute.', 'tweak/rescore');
  }
  const analysis = parseJsonFromText(resp.text);
  if (!analysis) {
    await refund();
    throw res({ error: 'Could not parse analysis output.' }, 502);
  }
  await env.DB.prepare(`UPDATE tweaks SET analysis_json = ? WHERE id = ?`).bind(JSON.stringify(analysis), tweakId).run();
  return res({ analysis, free });
}
