// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
import { res } from './helpers.js';

// ── Password hashing (PBKDF2, 100k iter, SHA-256) ──────────────

export async function hashPw(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = [...salt].map(b => b.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  const hashHex = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2:${saltHex}:${hashHex}`;
}

export async function checkPw(pw, stored) {
  if (!stored || !stored.startsWith('pbkdf2:')) return false;
  const [, saltHex, hashHex] = stored.split(':');
  // Fail closed on a malformed stored hash instead of throwing. A thrown error
  // here surfaced as a 500, which let attackers enumerate accounts by telling
  // 500 (no user / bad hash) apart from 401 (real user, wrong password). An
  // empty or odd-length saltHex makes .match(/.{2}/g) return null and crash.
  if (!saltHex || !hashHex || !/^([0-9a-fA-F]{2})+$/.test(saltHex)) return false;
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('') === hashHex;
}

// ── JWT (HS256) ────────────────────────────────────────────────
// Payload shape: { sub: userId, tv: tokenVersion, iat, exp }
// `tv` is verified against users.token_version on every authed request so
// password change / reset can invalidate every existing session immediately.

const enc = new TextEncoder();

function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlStr(str) { return b64url(enc.encode(str)); }
function b64urlDecode(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function requireSecret(secret) {
  // Refuse to sign or check logins without a real secret. A missing one would turn
  // into the word 'undefined', and anyone could forge a session.
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('JWT_SECRET must be set to a random string of 32+ characters.');
}

async function hmacKey(secret) {
  requireSecret(secret);
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function makeJWT(payload, secret) {
  const header = b64urlStr(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64urlStr(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
  return `${data}.${b64url(sig)}`;
}

export async function verifyJWT(token, secret) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(s), enc.encode(`${h}.${p}`));
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p))); } catch { return null; }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// Helper: build a session JWT for a user. Always reads the latest tv from DB
// so password-change / reset increments take effect on the next login.
export async function issueSessionJwt(env, userId, ttlSec = 30 * 86400) {
  const row = await env.DB.prepare('SELECT token_version FROM users WHERE id = ?').bind(userId).first();
  const tv = row?.token_version ?? 0;
  const now = Math.floor(Date.now() / 1000);
  return makeJWT({ sub: userId, tv, iat: now, exp: now + ttlSec }, env.JWT_SECRET);
}

// ── Cookie helpers ─────────────────────────────────────────────

export function authCookie(token, maxAgeSec = 60 * 60 * 24 * 30) {
  const attrs = [
    `rp_session=${token}`,
    'Path=/',
    `Max-Age=${maxAgeSec}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ];
  return attrs.join('; ');
}

export function clearCookie() {
  return 'rp_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax';
}

function readCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

// ── requireAuth ────────────────────────────────────────────────
// Throws a 401 Response if the user isn't authenticated OR their token_version
// no longer matches the DB (revoked via password change / reset). Returns the
// user id otherwise.

export async function requireAuth(request, env) {
  const token = readCookie(request, 'rp_session');
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload?.sub) throw res({ error: 'Unauthorized' }, 401);
  // Verify token_version: defends against stolen-cookie scenarios where the
  // user has since changed their password. Old JWT carries the old tv; DB has
  // the new tv; mismatch → forced re-login.
  const row = await env.DB.prepare('SELECT token_version FROM users WHERE id = ?')
    .bind(payload.sub).first();
  if (!row) throw res({ error: 'Unauthorized' }, 401);
  if ((row.token_version ?? 0) !== (payload.tv ?? 0)) {
    throw res({ error: 'Session expired. Please sign in again.' }, 401);
  }
  return payload.sub;
}

export async function optionalAuth(request, env) {
  const token = readCookie(request, 'rp_session');
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload?.sub) return null;
  const row = await env.DB.prepare('SELECT token_version FROM users WHERE id = ?')
    .bind(payload.sub).first();
  if (!row || (row.token_version ?? 0) !== (payload.tv ?? 0)) return null;
  return payload.sub;
}
