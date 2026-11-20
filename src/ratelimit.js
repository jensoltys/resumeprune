// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
import { res, clientIp, nowSec, sha256Hex } from './helpers.js';

// rate_limits keys never hold a raw IP: the IP is a salted sha256 (salt =
// JWT_SECRET, so the hash can't be reversed by walking the IPv4 space).
// Rows are purged daily by the cron (src/lib/purge.js).
export async function ipKey(env, ip) {
  return (await sha256Hex(`${env.JWT_SECRET || ''}|rl-ip|${ip}`)).slice(0, 32);
}

// rateLimit returns null on success, or a 429 Response if blocked.
// Records each attempt as a row in `rate_limits`, then counts rows in window.
// `customKey` overrides the default (which uses IP). Examples:
//   await rateLimit(request, env, 'auth', 10, 300)      → 10/5min/IP under 'auth'
//   await rateLimit(request, env, '', 30, 86400, `email:${emailHash}`) → 30/day for that email
export async function rateLimit(request, env, prefix, max, windowSec, customKey) {
  const key = customKey || `${prefix}:${await ipKey(env, clientIp(request))}`;
  const now = nowSec();
  const since = now - windowSec;

  // Drop the row up front; counting happens inclusively. Guarded: rate-limit
  // accounting must never take down the route it protects (migration 0012
  // removed the (key, ts) PK that made same-second bursts throw, but any
  // future insert failure should still fail open, not 500 a money path).
  try {
    await env.DB.prepare('INSERT INTO rate_limits (key, ts) VALUES (?, ?)').bind(key, now).run();
  } catch (e) {
    console.error('rate_limits insert failed (failing open)', e.message || e);
  }

  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM rate_limits WHERE key = ? AND ts >= ?'
  ).bind(key, since).first();

  // Opportunistic cleanup of older rows (10% sample to avoid hot-row contention)
  if (Math.random() < 0.1) {
    await env.DB.prepare('DELETE FROM rate_limits WHERE key = ? AND ts < ?').bind(key, since).run();
  }

  if ((row?.c || 0) > max) {
    return res({ error: 'Too many requests', retry_after: windowSec }, 429, {
      'Retry-After': String(windowSec),
    });
  }
  return null;
}

// globalCap is a server-side circuit breaker that counts ALL requests under a
// single shared key (no IP/email in the key), so distributed IP-rotation can't
// run an unbounded number of expensive calls. Use it to put a finite daily
// ceiling on cost-bomb surfaces (e.g. the public free-sample Claude calls).
//
// Returns null if under the cap (caller proceeds), or a 429 Response if the
// global ceiling for the window has been reached. Defaults to a daily window.
//
// The ceiling is configurable via env (so you can raise/lower it without a code
// change) and falls back to `defaultMax` when the env var is unset/invalid. Keep
// defaultMax low: a blank setting should fail toward a small AI bill, not a big one.
//   await globalCap(env, 'global:sample-claude', env.GLOBAL_SAMPLE_CAP, 50)
export async function globalCap(env, key, envValue, defaultMax) {
  const parsed = parseInt(envValue, 10);
  const max = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMax;
  // One atomic charge-and-compare per UTC day, so a parallel burst can't overshoot.
  if (await dailyBump(env, key, max)) return null;
  // Graceful, machine-readable refusal: no Claude call is made.
  return res(
    { error: "We've hit today's free-sample limit. Please try again tomorrow" + (!!(env.STRIPE_SECRET_KEY && (env.STRIPE_PRICE_PRO || env.STRIPE_PRICE_SPRINT)) ? ", or sign up for Pro to keep going." : "."), reason: 'global-cap', retry_after: 86400 },
    429,
    { 'Retry-After': '86400' }
  );
}

// ---------------------------------------------------------------------------
// App-wide daily ceilings (table daily_counts, migration 0018). One row per
// (key, UTC day). Used for email: a script rotating IPs can't get past a
// per-IP limit, but it can't get past a fixed number of mails per day either.
// Both helpers FAIL OPEN on a D1 error, same as rateLimit() above: a counter
// hiccup must never block a real signup or reset.
function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

// Count one use of `key` for today and say whether it's still within `max`.
// The check and the charge are one atomic upsert, so a burst of parallel
// requests can't overshoot the ceiling.
export async function dailyBump(env, key, max) {
  return bumpBucket(env, key, utcDay(), max, 'daily_counts bump');
}

// Same counter table, fixed time buckets instead of days (e.g. 15 min). Used
// for the per-address email cap. The bucket label is an ISO timestamp, so the
// purge's "day < yesterday" string compare clears old buckets too.
export async function windowBump(env, key, max, windowSec) {
  const start = Math.floor(Date.now() / 1000 / windowSec) * windowSec;
  const bucket = new Date(start * 1000).toISOString().slice(0, 16);
  return bumpBucket(env, key, bucket, max, 'window bump');
}

async function bumpBucket(env, key, day, max, label) {
  try {
    const row = await env.DB.prepare(
      'INSERT INTO daily_counts (k, day, n) VALUES (?, ?, 1) ON CONFLICT(k, day) DO UPDATE SET n = n + 1 RETURNING n'
    ).bind(key, day).first();
    return !row || row.n <= max;
  } catch (e) {
    console.error(`${label} failed (failing open)`, e.message || e);
    return true;
  }
}
