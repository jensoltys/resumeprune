// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
import { res, readJson, uuid, nowSec, sha256Hex, requireSameOrigin, freeSampleHash } from '../helpers.js';
import { rateLimit, dailyBump, windowBump } from '../ratelimit.js';
import { hashPw, checkPw, authCookie, clearCookie, requireAuth, issueSessionJwt } from '../auth.js';
import { issueToken, consumeToken, issueVerifyCode, peekUserCode } from '../lib/tokens.js';
import { sendEmail, verifyCodeTemplate, resetPasswordTemplate, accountExistsTemplate } from '../email.js';
import { cancelSubscription } from '../lib/stripe.js';
import { applyPendingProGrant } from '../lib/grants.js';
import { notifySignup } from '../lib/signup-notify.js';
import { authLog } from '../lib/auth-log.js';

function isoEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || '');
}

// Well-formed PBKDF2 dummy hash for the login no-user path: 16-byte (32 hex)
// salt + 32-byte (64 hex) hash, all zeros. checkPw runs full PBKDF2 against it
// and returns false, so a login for an unknown email takes the same time AND
// returns the same 401 as a real-email/wrong-password attempt (no enumeration).
const DUMMY_PW_HASH = 'pbkdf2:00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000';

// Per-account login lockout: 5 failed logins per email in 15 min.
// Defends against attackers rotating IPs against a single target account
// (the per-IP rate limit alone can't catch this). Uses the existing
// rate_limits table so cleanup + storage is consistent. Email is hashed
// so plaintext addresses don't sit in the rate-limit table.
// Reserves this attempt and counts in ONE batch, before the password is checked,
// so parallel guesses can't all slip past the count. A correct password clears it.
async function loginAttemptBlocked(env, email) {
  const key = `auth-login-email:${await sha256Hex(email)}`;
  const now = nowSec();
  const [, counted] = await env.DB.batch([
    env.DB.prepare('INSERT INTO rate_limits (key, ts) VALUES (?, ?)').bind(key, now),
    env.DB.prepare('SELECT COUNT(*) AS c FROM rate_limits WHERE key = ? AND ts >= ?').bind(key, now - 15 * 60),
  ]);
  return (counted?.results?.[0]?.c || 0) > 5;
}

async function clearLoginAttempts(env, email) {
  await env.DB.prepare('DELETE FROM rate_limits WHERE key = ?').bind(`auth-login-email:${await sha256Hex(email)}`).run();
}

// Bump token_version so every existing JWT for this user becomes invalid on
// the next requireAuth(). Called from password-change / reset / verify-email
// (post-verify session is the only one that should remain valid).
async function invalidateSessions(env, userId) {
  await env.DB.prepare(
    'UPDATE users SET token_version = COALESCE(token_version, 0) + 1, updated_at = ? WHERE id = ?'
  ).bind(nowSec(), userId).run();
}

// Email flood guard. Per-IP limits alone
// can't stop a script that rotates IPs from filling one person's inbox, or
// from burning your Resend sending quota. So, counted
// only when a mail is really about to go out (junk addresses cost nothing):
//   - per address: 3 sign-up/verification mails and 3 reset mails per 15 min
//   - app-wide: a fixed number of each kind per UTC day. Two separate counts,
//     so sign-up spam can't use up the resets a locked-out user needs.
// When a cap is hit the mail is skipped and the route answers exactly as if
// it had sent, so a cap never tells anyone whether an address has an account.
const MAIL_DAILY_VERIFY = 150; // sign-up + resend-code mails, all users, per day
const MAIL_DAILY_RESET = 150;  // reset-link mails, all users, per day
// Codes for people who already paid (guest checkout claim). Their own count, so a
// flood of sign-ups can never use up the codes a paying buyer is waiting for.
const MAIL_DAILY_CLAIM = 150;
const MAIL_PER_ADDRESS = 3;
const MAIL_VERIFY_PER_ADDRESS_DAY = 10;
const MAIL_PER_ADDRESS_WINDOW = 15 * 60;

// True when this mail may go out. Charges the address window, then the day,
// each as one atomic upsert-and-compare (daily_counts, migration 0018). Both
// fail open on a D1 error, like rateLimit(). Only call right before a send.
async function mailAllowed(env, kind, email) {
  const addrKey = `${kind}-mail:${await sha256Hex(email)}`;
  if (!(await windowBump(env, addrKey, MAIL_PER_ADDRESS, MAIL_PER_ADDRESS_WINDOW))) {
    console.log(JSON.stringify({ evt: 'mail_skipped', kind, reason: 'per-address-cap' }));
    return false;
  }
  // Each new code is 5 more guesses, so codes per address get a daily ceiling too.
  if ((kind === 'verify' || kind === 'claim') && !(await windowBump(env, `${kind}-mail-day:${await sha256Hex(email)}`, MAIL_VERIFY_PER_ADDRESS_DAY, 86400))) {
    console.log(JSON.stringify({ evt: 'mail_skipped', kind, reason: 'per-address-day-cap' }));
    return false;
  }
  const max = kind === 'reset' ? MAIL_DAILY_RESET : kind === 'claim' ? MAIL_DAILY_CLAIM : MAIL_DAILY_VERIFY;
  if (!(await dailyBump(env, `mail:${kind}`, max))) {
    console.log(JSON.stringify({ evt: 'mail_skipped', kind, reason: 'daily-cap' }));
    return false;
  }
  return true;
}

// A 6-digit code gets 5 wrong guesses, then it's burned and a fresh one has to be
// emailed. Only misses count, so nobody can lock out a person holding the right code.
// The reservation and the count are one batch, so parallel guesses can't slip past.
async function recordCodeMiss(env, userId) {
  const key = `verify-miss:${userId}`;
  const now = nowSec();
  const [, counted] = await env.DB.batch([
    env.DB.prepare('INSERT INTO rate_limits (key, ts) VALUES (?, ?)').bind(key, now),
    env.DB.prepare('SELECT COUNT(*) AS c FROM rate_limits WHERE key = ? AND ts >= ?').bind(key, now - 30 * 60),
  ]);
  if ((counted?.results?.[0]?.c || 0) < 5) return;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'verify'").bind(userId),
    env.DB.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key),
  ]);
}

// Guest checkout claim: same code as a normal signup, counted on its own caps
// ('claim'), never the sign-up ones.
export async function sendClaimCode(env, userId, email) {
  return (await mailAllowed(env, 'claim', email)) ? sendVerifyCode(env, userId, email) : true;
}

const CODE_NOT_SENT = "We couldn't send your code right now. Try Resend code in a minute, or email support@example.com.";

// Local testing (DEV_LOG_CODES=true and no email key): the code was printed, so say where.
function codeNotSent(env) {
  return env.DEV_LOG_CODES === 'true' && !env.RESEND_API_KEY
    ? "Email isn't set up on this copy, so your code is in the terminal where the app is running."
    : CODE_NOT_SENT;
}

// Issue + email a verification code. True only when Resend accepted the send;
// a skipped send (no API key) or any thrown error is false, never a silent success.
async function sendVerifyCode(env, userId, email) {
  try {
    const code = await issueVerifyCode(env, userId, 30 * 60);
    // Local testing only: DEV_LOG_CODES=true prints the code when no email key is set.
    if (env.DEV_LOG_CODES === 'true' && !env.RESEND_API_KEY) {
      console.log('[dev] verify code:', code);
    }
    const sent = await sendEmail(env, { to: email, ...verifyCodeTemplate({ code }) });
    return !(sent && sent.skipped);
  } catch (e) {
    console.error('Verify code issue/send failed', e);
    return false;
  }
}

export async function signup(request, env) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const rl = await rateLimit(request, env, 'auth-signup', 5, 600);
  if (rl) return rl;

  const body = await readJson(request);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const newsletter = body.newsletter === true;

  if (!isoEmail(email) || email.length > 254) return res({ error: 'Enter a valid email.' }, 400);
  if (password.length < 10) return res({ error: 'Password must be at least 10 characters.' }, 400);
  if (password.length > 200) return res({ error: 'Password too long.' }, 400);

  // Email enumeration: API response is always the generic "if new, check inbox"
  // — but if the email IS already registered, fire a different email to help
  // the legitimate user remember they have an account. The API response stays
  // identical either way, so an attacker probing for valid emails can't tell.
  const existing = await env.DB.prepare('SELECT id, email_verified FROM users WHERE email = ?').bind(email).first();
  if (existing && !existing.email_verified) {
    // Nobody has proved they own this address yet, and login refuses
    // unverified rows, so the row is unusable until someone does. The newest
    // signer-up takes over the credentials and gets a fresh code; entering it
    // is what proves ownership. Before this, a row squatted by someone else
    // kept ITS password, and the signup page's Resend link walked the real
    // owner into verifying that row and logging in on it (pre-hijack takeover).
    const pw = await hashPw(password);
    await env.DB.prepare('UPDATE users SET pw_hash = ?, token_version = COALESCE(token_version, 0) + 1, updated_at = ? WHERE id = ?')
      .bind(pw, nowSec(), existing.id).run();
    // At a mail cap the send is skipped but the answer reads as sent (no tell).
    const emailSent = (await mailAllowed(env, 'verify', email)) ? await sendVerifyCode(env, existing.id, email) : true;
    return res({
      ok: true, awaiting_verification: true, email, email_sent: emailSent,
      message: emailSent ? 'We emailed you a 6-digit code. Enter it to finish.' : codeNotSent(env),
    });
  }
  if (existing) {
    // Burn the same PBKDF2 cost as a real signup so timing does not tell.
    await hashPw(password);
    if (await mailAllowed(env, 'verify', email)) {
      try {
        const base = (env.APP_URL || '').replace(/\/+$/, '');
        await sendEmail(env, {
          to: email,
          ...accountExistsTemplate({
            loginUrl: `${base}/login`,
            resetUrl: `${base}/reset-password`,
          }),
        });
      } catch (e) {
        console.error('Account-exists notify failed', e.message);
      }
    }
    // Same shape as a fresh signup so the response cannot tell an attacker
    // whether the address is registered. The inbox owner gets the
    // "you already have an account" email above instead of a code.
    return res({ ok: true, awaiting_verification: true, email, email_sent: true, message: 'We emailed you a 6-digit code. Enter it to finish.' });
  }

  const id = uuid();
  const now = nowSec();
  const pw = await hashPw(password);
  await env.DB.prepare(
    `INSERT INTO users (id, email, pw_hash, plan, newsletter_consent, newsletter_consent_at, email_verified, token_version, created_at, updated_at)
     VALUES (?, ?, ?, 'free', ?, ?, 0, 0, ?, ?)`
  ).bind(id, email, pw, newsletter ? 1 : 0, newsletter ? now : null, now, now).run();

  // Kicked off before the verify email so the two network calls overlap; awaited
  // below because an un-awaited fetch gets cancelled when the response returns.
  const notified = notifySignup(env, 'resume-prune', email, newsletter);

  // Send a 6-digit code, not a magic link: Gmail silently drops link emails
  // from this young domain (accepts then never delivers). Code lands fine.
  // Wrapped so a token-write/email failure can never 500 the signup: the account
  // is already created and the user can hit "resend code". The response says
  // whether the code really went out so the page never claims it did when it
  // did not.
  // At a mail cap the account is still created and the answer reads as sent;
  // they can use Resend code later.
  const emailSent = (await mailAllowed(env, 'verify', email)) ? await sendVerifyCode(env, id, email) : true;
  await notified;

  return res({
    ok: true, awaiting_verification: true, email, email_sent: emailSent,
    message: emailSent ? 'We emailed you a 6-digit code. Enter it to finish.' : codeNotSent(env),
  });
}

// POST /api/auth/verify-code  body: { email, code, password }
// Finishes signup with the emailed 6-digit code, then issues a session so the
// existing pending-plan -> Stripe checkout hand-off (driven client-side) works
// exactly as it did after the old verify link.
export async function verifyCode(request, env) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const rl = await rateLimit(request, env, 'auth-verify-code', 10, 600);
  if (rl) return rl;

  const body = await readJson(request);
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').replace(/\D/g, '');
  const password = typeof body.password === 'string' ? body.password : '';
  if (!isoEmail(email) || code.length !== 6) return res({ error: 'Enter the 6-digit code from your email.' }, 400);
  if (!password || password.length > 200) return res({ error: 'Enter your password along with the code.' }, 400);
  // Throttle guesses per email too (6-digit space is small).
  const emailRl = await rateLimit(request, env, 'auth-verify-code-email', 8, 600, `verify-code:${await sha256Hex(email)}`);
  if (emailRl) return emailRl;

  const u = await env.DB.prepare('SELECT id, email_verified, pw_hash, token_version FROM users WHERE email = ?').bind(email).first();
  // The password comes first, with the same answer as a bad code. Someone who doesn't
  // hold this row's password learns nothing and can't burn the owner's code. A typo
  // doesn't cost the owner their code either. It also proves whoever set the row's
  // credentials is the one finishing, since a signup on an unverified row replaces them.
  // Every path does the same password work, and unknown, verified and unclaimed rows
  // get the same 400, so neither the answer nor its timing says an account exists
  //.
  const usable = u && !u.email_verified && String(u.pw_hash || '').startsWith('pbkdf2:');
  const pwOk = await checkPw(password, usable ? u.pw_hash : DUMMY_PW_HASH);
  if (!usable || !pwOk) return res({ error: 'That code is invalid or expired.' }, 400);
  const codeHash = await peekUserCode(env, u.id, code, 'verify');
  if (!codeHash) {
    await recordCodeMiss(env, u.id);
    return res({ error: 'That code is invalid or expired.' }, 400);
  }
  // Verify and burn the code in one transaction, and only if the row is still
  // exactly what was just checked: still unverified, same password hash, same
  // token_version, code still live. A signup that swapped the password between
  // the check above and here, or a parallel verify, matches 0 rows and gets
  // the generic 400 with no session.
  const now = nowSec();
  const tv = u.token_version ?? 0;
  const [upd, del] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET email_verified = 1, updated_at = ?
       WHERE id = ? AND email_verified = 0 AND pw_hash = ? AND COALESCE(token_version, 0) = ?
         AND EXISTS (SELECT 1 FROM email_tokens WHERE token_hash = ? AND user_id = ? AND purpose = 'verify' AND expires_at >= ?)`
    ).bind(now, u.id, u.pw_hash, tv, codeHash, u.id, now),
    env.DB.prepare("DELETE FROM email_tokens WHERE token_hash = ? AND user_id = ? AND purpose = 'verify'").bind(codeHash, u.id),
  ]);
  if (!upd?.meta?.changes || !del?.meta?.changes) return res({ error: 'That code is invalid or expired.' }, 400);
  // Land any affiliate Pro gift issued before this account verified.
  try { await applyPendingProGrant(env, u.id, email); } catch (e) { console.error('applyPendingProGrant (verify) failed', e.message); }
  const sessionToken = await issueSessionJwt(env, u.id);
  return res({ ok: true }, 200, { 'Set-Cookie': authCookie(sessionToken) });
}

// POST /api/auth/resend-code  body: { email } — re-issue a verification code for
// an unverified account. Generic response so it can't be used to probe emails.
export async function resendCode(request, env) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const rl = await rateLimit(request, env, 'auth-resend-code', 5, 600);
  if (rl) return rl;
  const body = await readJson(request);
  const email = String(body.email || '').trim().toLowerCase();
  if (!isoEmail(email)) return res({ ok: true });
  const emailRl = await rateLimit(request, env, 'auth-resend-code-email', 1, 60, `resend-code:${await sha256Hex(email)}`);
  if (emailRl) return emailRl;
  const u = await env.DB.prepare('SELECT id, email_verified, stripe_subscription_id FROM users WHERE email = ?').bind(email).first();
  // Unknown or already-verified emails still read as sent (no enumeration).
  // A real send that failed is reported so the page can say so. At a mail cap
  // the send is skipped and it still reads as sent (shares signup's caps).
  let emailSent = true;
  // A row with a subscription on it is a buyer finishing a claim: their resends
  // count on the claim caps too.
  if (u && !u.email_verified && await mailAllowed(env, u.stripe_subscription_id ? 'claim' : 'verify', email)) {
    emailSent = await sendVerifyCode(env, u.id, email);
  }
  return res({
    ok: true, email_sent: emailSent,
    message: emailSent ? 'If that account needs verification, a new code is on its way.' : codeNotSent(env),
  });
}

export async function login(request, env) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const rl = await rateLimit(request, env, 'auth-login', 10, 600);
  if (rl) return rl;

  const body = await readJson(request);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!isoEmail(email) || !password) return res({ error: 'Invalid credentials.' }, 401);

  // Per-account lockout (in addition to per-IP rate limit). Generic message
  // to avoid leaking whether the email exists.
  if (await loginAttemptBlocked(env, email)) {
    return res({ error: 'Too many failed attempts. Try again in 15 minutes.', retry_after: 900 }, 429, { 'Retry-After': '900' });
  }

  const u = await env.DB.prepare(
    'SELECT id, pw_hash, email_verified FROM users WHERE email = ?'
  ).bind(email).first();
  if (!u) {
    // Hash anyway to keep timing similar (anti-enumeration). The dummy hash must
    // be WELL-FORMED so checkPw actually runs PBKDF2 and returns false — a
    // malformed one ('pbkdf2:0:0') threw and 500'd, leaking account existence.
    await checkPw(password, DUMMY_PW_HASH);
    await authLog(request, env, 'login_fail', { email });
    return res({ error: 'Invalid credentials.' }, 401);
  }
  const ok = await checkPw(password, u.pw_hash);
  if (!ok) {
    await authLog(request, env, 'login_fail', { email });
    return res({ error: 'Invalid credentials.' }, 401);
  }
  await clearLoginAttempts(env, email);
  // Only after the password matched (so this never enumerates): an unverified
  // row has no proven owner and cannot start a session. The login page sends
  // them to the code box.
  if (!u.email_verified) {
    return res({ error: 'Please verify your email before logging in.', code: 'email_not_verified', email }, 403);
  }

  // Land any affiliate Pro gift issued before this account first logged in.
  try { await applyPendingProGrant(env, u.id, email); } catch (e) { console.error('applyPendingProGrant (login) failed', e.message); }
  await authLog(request, env, 'login_ok', { uid: u.id });
  const token = await issueSessionJwt(env, u.id);
  // Don't leak email_verified — frontend can read /api/profile if it needs that.
  return res(
    { ok: true },
    200,
    { 'Set-Cookie': authCookie(token) }
  );
}

export async function logout(request, env) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  return res({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}

export async function resetRequest(request, env, ctx) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const rl = await rateLimit(request, env, 'auth-reset', 5, 3600);
  if (rl) return rl;

  const body = await readJson(request);
  const email = String(body.email || '').trim().toLowerCase();
  if (!isoEmail(email)) return res({ error: 'Invalid email.' }, 400);

  // The lookup, the caps and the send all run AFTER the answer goes out, so the
  // time this route takes is the same whether or not the address has an account.
  const job = (async () => {
    const u = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    // Only a real send counts toward the caps. At a cap the mail is skipped and
    // the generic answer below goes out unchanged.
    if (u && await mailAllowed(env, 'reset', email)) {
      const raw = await issueToken(env, u.id, 'reset', 3600);
      const resetUrl = `${env.APP_URL}/reset-password?token=${encodeURIComponent(raw)}`;
      if (env.DEV_LOG_CODES === 'true' && !env.RESEND_API_KEY) {
        console.log('[dev] reset token:', raw);
      }
      try {
        await sendEmail(env, { to: email, ...resetPasswordTemplate({ resetUrl }) });
      } catch (e) {
        console.error('Reset email failed', e);
      }
    }
  })().catch(e => console.error('Reset request job failed', (e && e.message) || e));
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
  else await job; // tests and anything else with no request context
  return res({ ok: true, message: 'If that email exists, a reset link is on its way.' });
}

export async function resetConfirm(request, env) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const rl = await rateLimit(request, env, 'auth-reset-confirm', 10, 3600);
  if (rl) return rl;

  const body = await readJson(request);
  const token = String(body.token || '');
  const password = String(body.password || '');
  if (!token) return res({ error: 'Missing token.' }, 400);
  if (password.length < 10) return res({ error: 'Password must be at least 10 characters.' }, 400);
  if (password.length > 200) return res({ error: 'Password too long.' }, 400);

  const userId = await consumeToken(env, token, 'reset');
  if (!userId) return res({ error: 'Token invalid or expired.' }, 400);

  // One successful reset kills every other live reset link for this account.
  await env.DB.prepare("DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'reset'").bind(userId).run();
  const pw = await hashPw(password);
  await env.DB.prepare('UPDATE users SET pw_hash = ?, updated_at = ? WHERE id = ?')
    .bind(pw, nowSec(), userId).run();
  // Bump token_version so any session JWT issued before the reset is rejected.
  // A real owner who lost their password to a thief and reset it has now
  // forced the thief out.
  await invalidateSessions(env, userId);
  await authLog(request, env, 'password_reset', { uid: userId });
  return res({ ok: true });
}

export async function changePassword(request, env) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const uid = await requireAuth(request, env);
  const body = await readJson(request);
  const oldPw = String(body.currentPassword || '');
  const newPw = String(body.newPassword || '');
  if (newPw.length < 10) return res({ error: 'New password must be at least 10 characters.' }, 400);
  if (newPw.length > 200) return res({ error: 'New password too long.' }, 400);

  const u = await env.DB.prepare('SELECT pw_hash FROM users WHERE id = ?').bind(uid).first();
  if (!u || !(await checkPw(oldPw, u.pw_hash))) {
    return res({ error: 'Current password is wrong.' }, 401);
  }
  const pw = await hashPw(newPw);
  await env.DB.prepare('UPDATE users SET pw_hash = ?, updated_at = ? WHERE id = ?')
    .bind(pw, nowSec(), uid).run();
  // Bump tv so all OTHER sessions are kicked. Reissue a fresh cookie for THIS
  // session so the user doesn't get logged out of the tab they're on.
  await invalidateSessions(env, uid);
  await authLog(request, env, 'password_change', { uid });
  const newToken = await issueSessionJwt(env, uid);
  return res({ ok: true }, 200, { 'Set-Cookie': authCookie(newToken) });
}

// GET /api/account/export
// GDPR Article 15 (right to access) + Article 20 (right to portability).
// Returns every row keyed to this user across every table as a JSON download.
// Per-user burst rate limit so this endpoint can't be used to drain DB.
export async function exportAccount(request, env) {
  const uid = await requireAuth(request, env);
  const rl = await rateLimit(request, env, 'account-export', 3, 24 * 3600, `uid:${uid}:account-export`);
  if (rl) return rl;

  const userRow = await env.DB.prepare(
    `SELECT id, email, plan, plan_expires, stripe_customer_id, stripe_subscription_id, stripe_status,
            newsletter_consent, newsletter_consent_at, target_role, target_industry,
            email_verified, created_at, updated_at
     FROM users WHERE id = ?`
  ).bind(uid).first();
  if (!userRow) return res({ error: 'Account not found.' }, 404);

  const resume = await env.DB.prepare(
    // resumes has uploaded_at, not created_at (migrations/0001). The old column name 500'd
    // every export.
    `SELECT uid, raw_text, parsed_json, source_filename, uploaded_at, updated_at FROM resumes WHERE uid = ?`
  ).bind(uid).first();

  const { results: tweaks } = await env.DB.prepare(
    `SELECT id, jd, role_title, company_name, analysis_json, resume_json, cover_json, model_used, app_status, status_updated_at, rescores, created_at
     FROM tweaks WHERE uid = ? ORDER BY created_at DESC`
  ).bind(uid).all();

  const { results: usage } = await env.DB.prepare(
    `SELECT uid, period_key, tweaks_used FROM usage_counters WHERE uid = ?`
  ).bind(uid).all();

  const { results: payments } = await env.DB.prepare(
    `SELECT id, stripe_event_id, event_type, amount, currency, created_at
     FROM payment_events WHERE user_id = ? ORDER BY created_at DESC`
  ).bind(uid).all();

  const { results: gapFills } = await env.DB.prepare(
    `SELECT id, gap, job, body, created_at FROM gap_fills WHERE uid = ? ORDER BY created_at ASC`
  ).bind(uid).all();

  const { results: resumePages } = await env.DB.prepare(
    `SELECT id, tweak_id, slug, indexable, view_count, published_at, unpublished_at, style, accent, headline, links_json
     FROM resume_pages WHERE uid = ? ORDER BY published_at DESC`
  ).bind(uid).all();

  // Free samples are keyed by email_hash, not uid — match the email of the logged-in user.
  // Rows from before 2026-11-20 used an unsalted hash, so match both forms.
  const emailHash = await freeSampleHash(env, 'email', userRow.email);
  const legacyHash = await sha256Hex(String(userRow.email || '').trim().toLowerCase());
  const { results: freeSamples } = await env.DB.prepare(
    `SELECT id, email_hash, used_at, newsletter_consent, newsletter_consent_at
     FROM free_samples WHERE email_hash IN (?, ?) ORDER BY used_at DESC`
  ).bind(emailHash, legacyHash).all();

  const payload = {
    export_metadata: {
      generated_at: new Date().toISOString(),
      generated_at_epoch: nowSec(),
      data_controller: 'YOUR COMPANY NAME',
      contact: 'privacy@example.com',
      schema_version: 1,
      notes: 'This is every record we hold about your account in our database. Resumes and tweaks include the raw text you provided. Free-sample records are matched by hashed email; rate-limit rows are operational telemetry not tied to your identity and are not included. Feedback sent through the optional in-app widget isn\'t stored in this database. Request a copy by emailing privacy@example.com.',
    },
    user: userRow,
    resume: resume || null,
    gap_fills: gapFills || [],
    resume_pages: resumePages || [],
    tweaks: tweaks || [],
    usage_counters: usage || [],
    payment_events: payments || [],
    free_samples: freeSamples || [],
  };

  const filename = `resume-prune-export-${userRow.email.replace(/[^a-z0-9]+/gi, '-')}-${new Date().toISOString().slice(0, 10)}.json`;
  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

export async function deleteAccount(request, env) {
  // CSRF defense-in-depth: state-changing endpoint must originate from our pages.
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;

  const uid = await requireAuth(request, env);

  // Re-prompt password — stops session-hijack drive-by deletion + accidents.
  const body = await readJson(request);
  const password = String(body?.password || '');
  if (!password) return res({ error: 'Password is required to delete your account.' }, 400);

  const u = await env.DB.prepare(
    'SELECT email, pw_hash, stripe_subscription_id FROM users WHERE id = ?'
  ).bind(uid).first();
  if (!u) return res({ error: 'Account not found.' }, 404);

  const ok = await checkPw(password, u.pw_hash);
  if (!ok) {
    // Same shape as login fail; don't reveal anything else.
    return res({ error: 'Password is incorrect.' }, 401);
  }

  // Cancel Stripe subscription FIRST. If this fails we abort the delete so
  // the user isn't left in the state "row gone, Stripe still charging."
  if (u.stripe_subscription_id) {
    try {
      await cancelSubscription(env, u.stripe_subscription_id);
    } catch (e) {
      console.error('account-delete: cancel subscription failed', e.stripe?.error?.message || e.message, `uid=${uid}`);
      return res({
        error: 'We could not cancel your subscription. Please email privacy@example.com and we will delete your account manually.',
      }, 502);
    }
  }

  // Cascade is configured at the table level. Free samples are keyed by
  // hashed email, not user id, so they go explicitly. Remove the
  // user row last.
  // Rows from before 2026-11-20 used an unsalted hash, so delete both forms.
  const emailHash = await freeSampleHash(env, 'email', u.email);
  const legacyHash = await sha256Hex(String(u.email || '').trim().toLowerCase());
  await env.DB.batch([
    env.DB.prepare('DELETE FROM free_samples WHERE email_hash IN (?, ?)').bind(emailHash, legacyHash),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(uid),
  ]);
  await authLog(request, env, 'account_delete', { uid });
  return res({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}
