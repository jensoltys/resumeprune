// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
import { res, readJson, uuid, sha256Hex, nowSec, clientIp, freeSampleHash, aiReady, aiNotSetUp, aiFailure } from '../helpers.js';
import { rateLimit, globalCap, dailyBump, windowBump } from '../ratelimit.js';
import { callClaude, parseJsonFromText, HAIKU_FIRST_CHAIN, SONNET_FIRST_CHAIN } from '../anthropic.js';
import { PARSE_PROMPT, ANALYZE_PROMPT, TAILOR_PROMPT, COVER_PROMPT } from '../prompts.js';
import { sendEmail, freeSampleTemplate, buildUnsubscribeUrl } from '../email.js';
import { isOptedOut } from '../lib/unsubscribe.js';
import { isDisposableEmail } from '../lib/disposable-emails.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { scrubVoice, normalizeCover } from '../lib/output-scrub.js';
import { parseUserMsg, analyzeUserMsg, tailorUserMsg } from '../lib/prompt-messages.js';
import { markNoAlert } from '../lib/alert.js';
import { timingSafeEqual } from '../lib/stripe.js';
import { resumeChecks } from '../lib/resume-checks.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function isoEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || '');
}

// Allowlist of emails that bypass anti-abuse for your own testing. An email alone
// is typed by whoever sends the request, so it proves nothing: the caller must
// ALSO send the TEST_BYPASS_KEY secret in X-RP-Test-Key.
// No secret set = nobody is a tester.
function isTestEmail(env, email, request) {
  if (!env.TEST_EMAILS || !email || !env.TEST_BYPASS_KEY || !request) return false;
  const key = request.headers.get('X-RP-Test-Key') || '';
  if (!timingSafeEqual(key, String(env.TEST_BYPASS_KEY))) return false;
  const list = String(env.TEST_EMAILS).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(email);
}

// A test script hitting /generate can expect a 502 now and then (the model sometimes
// returns JSON the worker rejects) and retry it. Those retries shouldn't page anyone.
//
// Tag 5xx responses to TEST_EMAILS callers so the beacon skips them. Only 5xx
// is inspected, so the normal success path pays nothing but the clone.
function skipAlertForTesters(handler) {
  return async function (request, env) {
    const probe = request.clone();
    const response = await handler(request, env);
    if (response.status < 500) return response;
    let email = '';
    try {
      const body = await probe.json();
      email = String(body?.email || '').trim().toLowerCase();
    } catch { /* unparseable body — treat as real traffic and alert */ }
    return isTestEmail(env, email, request) ? markNoAlert(response) : response;
  };
}

// scrubVoice + normalizeCover live in src/lib/output-scrub.js so the Pro
// flow (tweak-routes.js) applies the same post-processing as the free flow.
// See the import at the top of this file.

// ── /api/sample/analyze ─────────────────────────────────────────────────────
// Two parallel Claude calls: one parses the resume (Haiku), one scores the
// match (Haiku). Returns both so /generate can skip re-parsing.
//
// This is the FIRST expensive (paid Claude) surface a visitor hits, and it's
// public. It is protected by three layers so it can't be turned into an
// Anthropic cost-bomb:
//   1. per-IP rate limit (5/hr)          — stops a single noisy client
//   2. Cloudflare Turnstile (bot check)  — stops headless/scripted abuse
//   3. global daily cap (circuit breaker)— stops distributed IP-rotation
// Layer 3 is the priority: it's the only one IP-rotation can't defeat.

// Exported below, wrapped in skipAlertForTesters().
async function sampleAnalyzeRoute(request, env) {
  const body = await readJson(request);

  if (body.website || body.url) {
    return res({ error: 'AI returned malformed analysis. Try again.' }, 502);
  }

  const resumeText = String(body.resumeText || '').trim();
  const jd = String(body.jobDescription || '').trim();
  const roleTitle = String(body.roleTitle || '').slice(0, 200);
  const companyName = String(body.companyName || '').slice(0, 200);
  // Optional — only used to let TEST_EMAILS bypass the bot check from a
  // test script (which has no browser to solve a Turnstile challenge).
  const email = String(body.email || '').trim().toLowerCase();
  const turnstileToken = String(body.turnstileToken || '').trim();
  const isTester = isTestEmail(env, email, request);

  // 5 match checks an hour per network. Testers (secret header) are exempt, so a
  // test run can't lock itself out.
  if (!isTester) {
    const rl = await rateLimit(request, env, 'sample-analyze', 5, 3600);
    if (rl) return rl;
  }

  if (resumeText.length < 100) return res({ error: 'Paste your full resume (at least 100 characters).' }, 400);
  if (resumeText.length > 30000) return res({ error: 'Resume too long. Trim to under 30,000 characters.' }, 400);
  if (jd.length < 50) return res({ error: 'Paste the full job description (at least 50 characters).' }, 400);
  if (jd.length > 12000) return res({ error: 'Job description too long. Trim to under 12,000 characters.' }, 400);
  if (!aiReady(env)) return aiNotSetUp();

  // Bot check (skipped for testers and no-op until TURNSTILE_SECRET_KEY is set).
  if (!isTester) {
    const ts = await verifyTurnstile(env, request, turnstileToken);
    if (!ts.ok) {
      return res({ error: 'Bot check failed. Please refresh and try again.', reason: ts.reason }, 400);
    }
  }

  // Global circuit breaker: a single shared counter across ALL callers so
  // distributed IP-rotation can't run the Anthropic bill to infinity. Testers
  // are exempt so test runs don't eat the public ceiling. Returns a clean 429.
  if (!isTester) {
    const capped = await globalCap(env, 'global:sample-claude', env.GLOBAL_SAMPLE_CAP, 50);
    if (capped) return capped;
  }

  let analysis, parsedResume;
  try {
    // Run parse + analyze in parallel — independent Haiku calls.
    const [parseResp, analyzeResp] = await Promise.all([
      callClaude(env, {
        system: PARSE_PROMPT.system,
        userMessage: parseUserMsg(resumeText),
        maxTokens: PARSE_PROMPT.maxTokens,
        models: HAIKU_FIRST_CHAIN,
      }),
      callClaude(env, {
        system: ANALYZE_PROMPT.system,
        userMessage: analyzeUserMsg({ resumeText, jd, roleTitle, companyName }),
        maxTokens: ANALYZE_PROMPT.maxTokens,
        models: HAIKU_FIRST_CHAIN,
      }),
    ]);
    parsedResume = scrubVoice(parseJsonFromText(parseResp.text));
    analysis = scrubVoice(parseJsonFromText(analyzeResp.text));
    if (!analysis) return res({ error: 'AI returned malformed analysis. Try again.' }, 502);
    if (!parsedResume) return res({ error: 'AI could not parse your resume. Try cleaning up the text and pasting again.' }, 502);
  } catch (e) {
    return aiFailure(e, "The match check didn't finish. Try again in a minute.", 'sample/analyze');
  }

  return res({ analysis, parsedResume, resumeChecks: resumeChecks(parsedResume, resumeText, jd) });
}

// ── Anti-abuse counters ─────────────────────────────────────────────────────

// A row counts toward the limits once it holds a result, or while it is a fresh
// reservation (a request still running). A reservation whose request died is
// ignored after RESERVATION_TTL, so a crash can't cost anyone a free sample.
const RESERVATION_TTL = 600;
const COUNTS = '(result_json IS NOT NULL OR used_at >= ?)';

async function checkFreeSampleLimit(env, emailHash, ipHash, emailDomain) {
  const monthAgo = nowSec() - 30 * 86400;
  const dayAgo = nowSec() - 86400;
  const live = nowSec() - RESERVATION_TTL;

  const byEmail = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM free_samples WHERE email_hash = ? AND used_at >= ? AND ${COUNTS}`
  ).bind(emailHash, monthAgo, live).first();
  if ((byEmail?.c || 0) >= 2) return { ok: false, reason: 'email-limit' };

  const byIp = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM free_samples WHERE ip_hash = ? AND used_at >= ? AND ${COUNTS}`
  ).bind(ipHash, monthAgo, live).first();
  if ((byIp?.c || 0) >= 5) return { ok: false, reason: 'ip-limit' };

  const byIpDay = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM free_samples WHERE ip_hash = ? AND used_at >= ? AND ${COUNTS}`
  ).bind(ipHash, dayAgo, live).first();
  if ((byIpDay?.c || 0) >= 3) return { ok: false, reason: 'ip-burst' };

  if (emailDomain) {
    const byDomain = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM free_samples WHERE email_domain = ? AND used_at >= ? AND ${COUNTS}`
    ).bind(emailDomain.toLowerCase(), dayAgo, live).first();
    if ((byDomain?.c || 0) >= 30) return { ok: false, reason: 'domain-burst' };
  }

  return { ok: true };
}

// Take this visitor's sample slot BEFORE any AI call. The limits are checked and
// the row is written in ONE statement, so a burst of parallel requests can't all
// read "under the limit" and all run. Same four limits as checkFreeSampleLimit.
// Returns true when the slot was taken. The row holds no result yet.
async function reserveSample(env, { sampleId, emailHash, ipHash, emailDomain, now, newsletter }) {
  const monthAgo = now - 30 * 86400, dayAgo = now - 86400, live = now - RESERVATION_TTL;
  const r = await env.DB.prepare(
    `INSERT INTO free_samples (id, email_hash, email_domain, ip_hash, used_at, newsletter_consent, newsletter_consent_at, result_json)
     SELECT ?, ?, ?, ?, ?, ?, ?, NULL
     WHERE (SELECT COUNT(*) FROM free_samples WHERE email_hash = ? AND used_at >= ? AND ${COUNTS}) < 2
       AND (SELECT COUNT(*) FROM free_samples WHERE ip_hash = ? AND used_at >= ? AND ${COUNTS}) < 5
       AND (SELECT COUNT(*) FROM free_samples WHERE ip_hash = ? AND used_at >= ? AND ${COUNTS}) < 3
       AND (SELECT COUNT(*) FROM free_samples WHERE email_domain = ? AND used_at >= ? AND ${COUNTS}) < 30`
  ).bind(
    sampleId, emailHash, emailDomain, ipHash, now, newsletter ? 1 : 0, newsletter ? now : null,
    emailHash, monthAgo, live,
    ipHash, monthAgo, live,
    ipHash, dayAgo, live,
    emailDomain, dayAgo, live,
  ).run();
  return (r.meta?.changes || 0) === 1;
}

// Give the slot back when no result was made (AI failure, daily ceiling).
async function releaseSample(env, sampleId) {
  try {
    await env.DB.prepare('DELETE FROM free_samples WHERE id = ? AND result_json IS NULL').bind(sampleId).run();
  } catch (e) { console.error('free sample release failed', e.message || e); }
}

export const sampleAnalyze = skipAlertForTesters(sampleAnalyzeRoute);

// ── /api/sample/generate ────────────────────────────────────────────────────
// Expects { resumeText, jobDescription, parsedResume?, ... }.
// If parsedResume is provided (from a prior /analyze call), skip the parse step.
// If not, re-parse server-side (paranoia path; e.g. user JS-disabled).

// Exported below, wrapped in skipAlertForTesters().
async function sampleGenerateRoute(request, env) {
  const body = await readJson(request);

  if (body.website || body.url) {
    return res({ error: 'AI returned malformed analysis. Try again.' }, 502);
  }

  const resumeText = String(body.resumeText || '').trim();
  const jd = String(body.jobDescription || '').trim();
  const roleTitle = String(body.roleTitle || '').slice(0, 200);
  const companyName = String(body.companyName || '').slice(0, 200);
  const email = String(body.email || '').trim().toLowerCase();
  const newsletter = body.newsletter === true;
  const turnstileToken = String(body.turnstileToken || '').trim();
  let parsedResume = body.parsedResume && typeof body.parsedResume === 'object' ? body.parsedResume : null;
  // Client-supplied, so it gets a ceiling like the pasted text does. Oversized = parse it ourselves.
  if (parsedResume && JSON.stringify(parsedResume).length > 40000) parsedResume = null;

  if (!isoEmail(email)) return res({ error: 'Enter a valid email.' }, 400);

  const isTester = isTestEmail(env, email, request);

  if (!isTester && isDisposableEmail(email)) {
    return res({ error: 'Please use your real email address. Disposable inboxes are not allowed.' }, 400);
  }
  if (resumeText.length < 100) return res({ error: 'Paste your full resume.' }, 400);
  if (resumeText.length > 30000) return res({ error: 'Resume too long.' }, 400);
  if (jd.length < 50) return res({ error: 'Paste the full job description.' }, 400);
  if (jd.length > 12000) return res({ error: 'Job description too long.' }, 400);
  if (!aiReady(env)) return aiNotSetUp();

  if (!isTester) {
    const ts = await verifyTurnstile(env, request, turnstileToken);
    if (!ts.ok) {
      return res({ error: 'Bot check failed. Please refresh and try again.', reason: ts.reason }, 400);
    }
  }

  if (!isTester) {
    const rl = await rateLimit(request, env, 'sample-generate', 10, 3600);
    if (rl) return rl;
  }

  const ip = clientIp(request);
  // Salted with the server secret, so a leaked table can't be reversed by
  // hashing every IPv4 address or a list of emails.
  const emailHash = await freeSampleHash(env, 'email', email);
  const ipHash = await freeSampleHash(env, 'ip', ip);
  const emailDomain = email.slice(email.lastIndexOf('@') + 1);

  const now = nowSec();
  const sampleId = uuid();
  const limitAnswer = (reason) => {
    const sells = !!(env.STRIPE_SECRET_KEY && (env.STRIPE_PRICE_PRO || env.STRIPE_PRICE_SPRINT));
    const msg = reason === 'email-limit'
      ? "You've used both free samples for this month." + (sells ? " Sign up for Pro or Sprint to keep going." : "")
      : reason === 'ip-burst'
        ? "Lots of activity from your network in the last day. Try again tomorrow" + (sells ? " or sign up for Pro." : ".")
        : reason === 'domain-burst'
          ? "Lots of activity from your email domain today. Try again tomorrow."
          : "We see lots of activity from your network." + (sells ? " Sign up for Pro to keep going." : " Try again later.");
    // 24h Retry-After is approximate — abuse limits roll over daily.
    return res({ error: msg, reason, retry_after: 86400 }, 429, { 'Retry-After': '86400' });
  };

  // Testers skip the limits AND the row. Otherwise test runs + manual QA
  // accumulate rows under the tester's IP that block real signups from that network
  // (the 5/IP/30d limit fires even though TEST_EMAILS bypasses the check on
  // the test request itself). Testers see the data inline in this response;
  // they don't need the viewer URL because we also skip the email send for
  // testers, so there's no link to click.
  let reserved = false;
  if (!isTester) {
    const limit = await checkFreeSampleLimit(env, emailHash, ipHash, emailDomain);
    if (!limit.ok) return limitAnswer(limit.reason);
    // The check above only picks the message. This is the one that decides: it
    // counts and writes in a single statement, so parallel requests can't all pass.
    reserved = await reserveSample(env, { sampleId, emailHash, ipHash, emailDomain, now, newsletter });
    if (!reserved) {
      const again = await checkFreeSampleLimit(env, emailHash, ipHash, emailDomain);
      return limitAnswer(again.ok ? 'email-limit' : again.reason);
    }

    // Global circuit breaker shared with /analyze — even past the per-email/IP
    // abuse counters, the total number of paid free-sample Claude calls per day
    // is capped so distributed abuse can't run up an unbounded Anthropic bill
    //. Testers are exempt. Returns a clean 429.
    const capped = await globalCap(env, 'global:sample-claude', env.GLOBAL_SAMPLE_CAP, 50);
    if (capped) { await releaseSample(env, sampleId); return capped; }
  }

  let resumeJson, coverJson;
  let stored = false;
  try {
    // If the frontend didn't pass parsedResume (skipped analyze, or stale state),
    // do the parse here so the tailor stage still has structured input.
    if (!parsedResume) {
      const p = await callClaude(env, {
        system: PARSE_PROMPT.system,
        userMessage: parseUserMsg(resumeText),
        maxTokens: PARSE_PROMPT.maxTokens,
        models: HAIKU_FIRST_CHAIN,
      });
      parsedResume = scrubVoice(parseJsonFromText(p.text));
      if (!parsedResume) return res({ error: 'AI could not parse your resume. Try cleaning up the text.' }, 502);
    }

    // Stage 3: tailor (Sonnet, against structured input).
    // Stage 4: cover (Haiku, against same structured input).
    // Run in parallel — both depend only on parsedResume + JD, not on each other.
    const [tailorResp, coverResp] = await Promise.all([
      callClaude(env, {
        system: TAILOR_PROMPT.system,
        userMessage: tailorUserMsg({ parsedResume, jd, roleTitle, companyName }),
        maxTokens: TAILOR_PROMPT.maxTokens,
        models: SONNET_FIRST_CHAIN,
      }),
      callClaude(env, {
        system: COVER_PROMPT.system,
        userMessage: tailorUserMsg({ parsedResume, jd, roleTitle, companyName }),
        maxTokens: COVER_PROMPT.maxTokens,
        models: HAIKU_FIRST_CHAIN,
      }),
    ]);
    resumeJson = scrubVoice(parseJsonFromText(tailorResp.text));
    if (!resumeJson) return res({ error: 'AI returned malformed resume. Try again.' }, 502);

    coverJson = normalizeCover(scrubVoice(parseJsonFromText(coverResp.text)));
    if (!coverJson) return res({ error: 'AI returned malformed cover letter. Try again.' }, 502);

    // Fill in the reserved row. From here on it counts for good.
    if (reserved) {
      await env.DB.prepare('UPDATE free_samples SET result_json = ? WHERE id = ?')
        .bind(JSON.stringify({ resume: resumeJson, cover: coverJson }), sampleId).run();
    }
    stored = true;
  } catch (e) {
    return aiFailure(e, "Your resume and cover letter didn't finish. Try again in a minute.", 'sample/generate');
  } finally {
    // Every early return above lands here: no result, so the slot goes back.
    if (reserved && !stored) await releaseSample(env, sampleId);
  }

  const viewerUrl = `${env.APP_URL}/sample.html?id=${sampleId}`;
  const signupUrl = `${env.APP_URL}/signup?from=sample`;
  // Skip the welcome email for TEST_EMAILS addresses — those are your own
  // testing addresses, and real mail to them floods your inbox during test runs.
  if (!isTester) {
    try {
      // This address is unconfirmed, so sample mail gets the same kind of caps as signup mail.
      if (await windowBump(env, `sample-mail:${emailHash}`, 3, 15 * 60) && await dailyBump(env, 'mail:sample', 150)) {
        await sendSampleEmail(env, { email, resumeJson, coverJson, viewerUrl, signupUrl });
      }
    } catch (e) {
      console.error('Email send failed (sample); user already saw output', e);
    }
  }

  return res({ resume: resumeJson, cover: coverJson, sampleId, viewerUrl });
}

// The person asked for these results, so the email always goes out, even to an
// address that unsubscribed from product mail. Only the plans pitch is held back.
export async function sendSampleEmail(env, { email, resumeJson, coverJson, viewerUrl, signupUrl }) {
  // Anyone can type any address into the sample form, so an address that has
  // unsubscribed gets nothing at all from it (results still show on the page).
  const optedOut = await isOptedOut(env, await sha256Hex(String(email).trim().toLowerCase()));
  if (optedOut) return { skipped: true, reason: 'opted-out' };
  const unsubscribeUrl = await buildUnsubscribeUrl(env, email);
  const tpl = freeSampleTemplate({ resumeJson, coverJson, viewerUrl, signupUrl, unsubscribeUrl, promo: !!(env.STRIPE_SECRET_KEY && (env.STRIPE_PRICE_PRO || env.STRIPE_PRICE_SPRINT)) });
  return sendEmail(env, { to: email, ...tpl });
}

// ── /api/sample/result/:id ──────────────────────────────────────────────────

export const sampleGenerate = skipAlertForTesters(sampleGenerateRoute);

export async function sampleResult(request, env, id) {
  if (!id || !/^[a-f0-9-]{8,}$/i.test(id)) return res({ error: 'Invalid id' }, 400);
  const row = await env.DB.prepare(
    'SELECT result_json, used_at FROM free_samples WHERE id = ?'
  ).bind(id).first();
  if (!row) return res({ error: 'Not found' }, 404);
  // The daily purge clears result_json at 30 days, so an emptied row is expired.
  if (!row.result_json) return res({ error: "This sample has expired. Free sample results are deleted 30 days after they're made." }, 410);
  const ageDays = (nowSec() - row.used_at) / 86400;
  if (ageDays > 30) return res({ error: "This sample has expired. Free sample results are deleted 30 days after they're made." }, 410);
  let parsed;
  try { parsed = JSON.parse(row.result_json); } catch { return res({ error: 'Corrupt sample data' }, 500); }
  return res(parsed);
}
