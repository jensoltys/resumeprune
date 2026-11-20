// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
import { res, readJson, nowSec, requireSameOrigin, aiReady, aiNotSetUp, aiFailure } from '../helpers.js';
import { requireAuth } from '../auth.js';
import { periodKeyFor, planLimit, effectivePlan } from '../lib/usage.js';
import { callClaude, parseJsonFromText, HAIKU_FIRST_CHAIN } from '../anthropic.js';
import { PARSE_PROMPT } from '../prompts.js';
import { parseUserMsg } from '../lib/prompt-messages.js';
import { rateLimit, dailyBump } from '../ratelimit.js';
import { resumeChecks } from '../lib/resume-checks.js';

// GET /api/profile
export async function getProfile(request, env) {
  const uid = await requireAuth(request, env);
  const user = await env.DB.prepare(
    `SELECT id, email, plan, plan_expires, stripe_subscription_id, target_role, target_industry,
            newsletter_consent, email_verified, created_at
     FROM users WHERE id = ?`
  ).bind(uid).first();
  if (!user) throw res({ error: 'User not found' }, 404);

  const resumeRow = await env.DB.prepare(
    `SELECT uploaded_at, updated_at, source_filename, parsed_json, raw_text FROM resumes WHERE uid = ?`
  ).bind(uid).first();

  // Parse the stored resume JSON so the account/onboarding editor can load the
  // existing resume for in-place editing (fix a name typo, etc.) instead of
  // forcing a re-upload. Tolerate a corrupt row by returning null.
  let resumeParsed = null;
  if (resumeRow?.parsed_json) {
    try { resumeParsed = JSON.parse(resumeRow.parsed_json); } catch { resumeParsed = null; }
  }

  return res({
    user: {
      id: user.id,
      email: user.email,
      plan: effectivePlan(user, env),
      has_stripe: !!user.stripe_subscription_id,
      plan_expires: user.plan_expires,
      target_role: user.target_role || '',
      target_industry: user.target_industry || '',
      newsletter_consent: !!user.newsletter_consent,
      email_verified: !!user.email_verified,
      created_at: user.created_at,
    },
    has_resume: !!resumeRow,
    resume_meta: resumeRow ? {
      uploaded_at: resumeRow.uploaded_at,
      updated_at: resumeRow.updated_at,
      source_filename: resumeRow.source_filename,
    } : null,
    // Full editable resume (parsed fields + original text) for the in-place editor.
    resume: resumeRow ? {
      parsed: resumeParsed,
      raw: resumeRow.raw_text || '',
    } : null,
  });
}

// PUT /api/profile
export async function updateProfile(request, env) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const uid = await requireAuth(request, env);
  const body = await readJson(request);

  const target_role = typeof body.target_role === 'string' ? body.target_role.slice(0, 200).trim() : null;
  const target_industry = typeof body.target_industry === 'string' ? body.target_industry.slice(0, 200).trim() : null;
  const wantsNewsletter = body.newsletter_consent === true;

  // Look up current consent to know if we should backfill the timestamp.
  const cur = await env.DB.prepare(
    `SELECT newsletter_consent FROM users WHERE id = ?`
  ).bind(uid).first();
  if (!cur) throw res({ error: 'User not found' }, 404);

  const consentChanged = (!!cur.newsletter_consent) !== wantsNewsletter;
  const now = nowSec();

  await env.DB.prepare(
    `UPDATE users SET
       target_role = ?,
       target_industry = ?,
       newsletter_consent = ?,
       newsletter_consent_at = CASE WHEN ? THEN ? ELSE newsletter_consent_at END,
       updated_at = ?
     WHERE id = ?`
  ).bind(
    target_role,
    target_industry,
    wantsNewsletter ? 1 : 0,
    consentChanged ? 1 : 0, now,
    now,
    uid
  ).run();

  return res({ ok: true });
}

// GET /api/pro-status
export async function getProStatus(request, env) {
  const uid = await requireAuth(request, env);
  const user = await env.DB.prepare(
    `SELECT plan, plan_expires, stripe_subscription_id FROM users WHERE id = ?`
  ).bind(uid).first();
  if (!user) throw res({ error: 'User not found' }, 404);

  const plan = effectivePlan(user, env);
  const periodKey = periodKeyFor(plan);
  const counter = await env.DB.prepare(
    `SELECT tweaks_used FROM usage_counters WHERE uid = ? AND period_key = ?`
  ).bind(uid, periodKey).first();
  const used = counter?.tweaks_used || 0;
  const limit = planLimit(plan);
  // Lifetime tweaks drive the pruning rank card (Sprout Snipper at 1 ... Bonsai Master at 40).
  const lifetime = await env.DB.prepare(
    `SELECT COALESCE(SUM(tweaks_used), 0) AS n FROM usage_counters WHERE uid = ?`
  ).bind(uid).first();

  return res({
    plan,
    open: plan === 'open',                      // paid plans are off on this copy: no plan needed
    has_stripe: !!user.stripe_subscription_id,  // gifted users have none — UI hides "Manage subscription"
    plan_expires: user.plan_expires || null,    // epoch seconds; gifted users show "free testing until <date>"
    period_key: periodKey,
    tweaks_used: used,
    tweaks_limit: limit,
    tweaks_remaining: Math.max(0, limit - used),
    lifetime_tweaks: Number(lifetime?.n) || 0,
  });
}

// POST /api/profile/upload-resume
// App-wide ceiling on AI resume parses by accounts with NO plan, per UTC day. The
// per-account limits below stop one account. This stops a pile of throwaway
// accounts from each spending their own 10 a day on your AI bill. Accounts on a
// plan never count toward it. Set FREE_PARSE_DAILY_CAP to change it.
const FREE_PARSE_DAILY_DEFAULT = 200;
function freeParseCap(env) {
  const n = parseInt(env.FREE_PARSE_DAILY_CAP, 10);
  return Number.isFinite(n) && n > 0 ? n : FREE_PARSE_DAILY_DEFAULT;
}

export async function uploadResume(request, env) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const uid = await requireAuth(request, env);
  // No AI key: say so before any limit is spent.
  if (!aiReady(env)) return aiNotSetUp();
  // Every upload is a Claude parse, and any signed-in account (free included) can call it.
  // cap it per user so a script can't loop paid parses.
  // Burst: 3 per minute. Daily: 10 per day (a real person re-uploads a few times at most).
  const burstBlock = await rateLimit(request, env, 'upload-resume', 3, 60, `uid:${uid}:upload-resume`);
  if (burstBlock) {
    return res({ error: "That's a lot of uploads in a row. Give it a minute and try again.", code: 'RATE_LIMITED', retry_after: 60 }, 429, { 'Retry-After': '60' });
  }
  const dayBlock = await rateLimit(request, env, 'upload-resume-day', 10, 86400, `uid:${uid}:upload-resume-day`);
  if (dayBlock) {
    return res({ error: "You've hit today's resume upload limit. You can still edit your saved resume, or upload again tomorrow.", code: 'RATE_LIMITED', retry_after: 86400 }, 429, { 'Retry-After': '86400' });
  }
  const body = await readJson(request);

  const rawText = typeof body.rawText === 'string' ? body.rawText.trim() : '';
  const sourceFilename = typeof body.sourceFilename === 'string' ? body.sourceFilename.slice(0, 200) : null;

  if (rawText.length < 50)    throw res({ error: 'Resume text seems too short. Paste at least a few sentences or upload a complete resume.' }, 400);
  if (rawText.length > 50000) throw res({ error: 'Resume text is too long (max 50,000 characters).' }, 400);

  // Accounts with no plan share one daily ceiling (see freeParseCap). One atomic
  // count-and-compare, charged only for text that passed the checks above.
  const planRow = await env.DB.prepare('SELECT plan, plan_expires, stripe_subscription_id FROM users WHERE id = ?').bind(uid).first();
  if (planLimit(effectivePlan(planRow, env)) === 0 && !(await dailyBump(env, 'ai:free-parse', freeParseCap(env)))) {
    return res({ error: "We've hit today's limit for reading new resumes on accounts without a plan. Try again tomorrow.", code: 'RATE_LIMITED', reason: 'free-parse-cap', retry_after: 86400 }, 429, { 'Retry-After': '86400' });
  }

  // Same message format as the free flow's parse stage — reuse parseUserMsg.
  let parseResp;
  try {
    parseResp = await callClaude(env, {
      system: PARSE_PROMPT.system,
      userMessage: parseUserMsg(rawText),
      maxTokens: PARSE_PROMPT.maxTokens || 3000,
      models: HAIKU_FIRST_CHAIN,
    });
  } catch (e) {
    throw aiFailure(e, 'Could not extract structured data from your resume. Try a cleaner copy/paste.', 'upload-resume');
  }
  const parsed = parseJsonFromText(parseResp.text);
  if (!parsed || typeof parsed !== 'object') {
    throw res({ error: 'Could not extract structured data from your resume. Try a cleaner copy/paste.' }, 502);
  }

  // Heuristic gentle warnings the review screen surfaces above the form.
  const suggestEdits = [];
  if (!parsed.name)                                  suggestEdits.push('Name not detected. Please add it.');
  if (!parsed.contact?.email)                        suggestEdits.push('No email on the resume. Add one so recruiters can reach you.');
  if (!Array.isArray(parsed.experience) || !parsed.experience.length) suggestEdits.push('No work experience extracted. Review and fill in.');
  if (Array.isArray(parsed.experience)) {
    parsed.experience.forEach((j, i) => {
      if (!j.bullets || !j.bullets.length) suggestEdits.push(`"${j.role || j.company || `Role ${i+1}`}" has no bullets. Add achievements.`);
    });
  }

  return res({
    parsed,
    suggestEdits,
    resumeChecks: resumeChecks(parsed, rawText),
    sourceFilename,
    rawTextEcho: rawText, // returned so the client can hold onto it through the wizard until save
  });
}

// PUT /api/profile/resume
export async function saveResume(request, env) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const uid = await requireAuth(request, env);
  const body = await readJson(request);

  const parsedJson = body.parsedJson;
  const rawText = typeof body.rawText === 'string' ? body.rawText.trim() : '';
  const sourceFilename = typeof body.sourceFilename === 'string' ? body.sourceFilename.slice(0, 200) : null;

  if (!parsedJson || typeof parsedJson !== 'object') throw res({ error: 'parsedJson is required.' }, 400);
  if (rawText.length < 50) throw res({ error: 'rawText is required (at least 50 chars).' }, 400);
  if (rawText.length > 50000) throw res({ error: 'rawText exceeds 50,000 character limit.' }, 400);
  if (!parsedJson.name || typeof parsedJson.name !== 'string' || !parsedJson.name.trim()) {
    throw res({ error: 'Your resume needs a name. Add one in the review step.' }, 400);
  }

  const json = JSON.stringify(parsedJson);
  if (json.length > 200000) throw res({ error: 'Parsed resume is too large.' }, 400);

  const now = nowSec();
  // Upsert: REPLACE INTO matches the PRIMARY KEY (uid).
  await env.DB.prepare(
    `INSERT INTO resumes (uid, raw_text, parsed_json, source_filename, uploaded_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET
       raw_text = excluded.raw_text,
       parsed_json = excluded.parsed_json,
       source_filename = COALESCE(excluded.source_filename, resumes.source_filename),
       updated_at = excluded.updated_at`
  ).bind(uid, rawText, json, sourceFilename, now, now).run();

  return res({ ok: true });
}
