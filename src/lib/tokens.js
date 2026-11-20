// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
import { nowSec, sha256Hex } from '../helpers.js';

// Single-use email tokens (verify, reset).
// We store the SHA-256 hash so a DB leak doesn't yield usable tokens.

export async function issueToken(env, userId, purpose, ttlSec) {
  const raw = crypto.randomUUID() + '.' + crypto.randomUUID();
  const hash = await sha256Hex(raw);
  const now = nowSec();
  await env.DB.prepare(
    'INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(hash, userId, purpose, now + ttlSec, now).run();
  return raw;
}

export async function consumeToken(env, raw, purpose) {
  const hash = await sha256Hex(raw);
  const row = await env.DB.prepare(
    'SELECT user_id, purpose, expires_at FROM email_tokens WHERE token_hash = ?'
  ).bind(hash).first();
  if (!row) return null;
  if (row.purpose !== purpose) return null;
  if (row.expires_at < nowSec()) return null;
  await env.DB.prepare('DELETE FROM email_tokens WHERE token_hash = ?').bind(hash).run();
  return row.user_id;
}

// Issue a 6-digit verification code for a specific user. Low-entropy, so it is
// stored hashed AND always consumed scoped to the user (see consumeUserCode) —
// a bare token_hash lookup would collide across users who share a code.
export async function issueVerifyCode(env, userId, ttlSec) {
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  // Scope the stored hash to the user. token_hash is the PRIMARY KEY, so a bare
  // sha256(code) would collide (and 500 the signup) whenever two users drew the
  // same 6-digit code. Mixing in userId makes it unique per user.
  const hash = await sha256Hex(userId + ':' + code);
  const now = nowSec();
  // One live verify code per user.
  await env.DB.prepare("DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'verify'").bind(userId).run();
  await env.DB.prepare(
    'INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(hash, userId, 'verify', now + ttlSec, now).run();
  return code;
}

// Consume a code scoped to a known user (match on user_id AND hash) so shared
// 6-digit codes can never verify the wrong account. Single-use.
export async function consumeUserCode(env, userId, raw, purpose) {
  const hash = await sha256Hex(userId + ':' + raw); // user-scoped (current format)
  const legacyHash = await sha256Hex(raw);          // pre-fix unscoped format, accepted during transition
  const row = await env.DB.prepare(
    'SELECT token_hash, expires_at FROM email_tokens WHERE token_hash IN (?, ?) AND user_id = ? AND purpose = ?'
  ).bind(hash, legacyHash, userId, purpose).first();
  if (!row) return false;
  if (row.expires_at < nowSec()) return false;
  await env.DB.prepare('DELETE FROM email_tokens WHERE token_hash = ? AND user_id = ?').bind(row.token_hash, userId).run();
  return true;
}

// Read-only twin of consumeUserCode: returns the stored token_hash when the
// code is live for this user (null otherwise), without using it up.
// verify-code checks the code, then the password, then verifies and burns the
// code in one conditional batch keyed on this hash, so a typo in the password
// doesn't cost the user their code.
export async function peekUserCode(env, userId, raw, purpose) {
  const hash = await sha256Hex(userId + ':' + raw);
  const legacyHash = await sha256Hex(raw);
  const row = await env.DB.prepare(
    'SELECT token_hash, expires_at FROM email_tokens WHERE token_hash IN (?, ?) AND user_id = ? AND purpose = ?'
  ).bind(hash, legacyHash, userId, purpose).first();
  return row && row.expires_at >= nowSec() ? row.token_hash : null;
}
