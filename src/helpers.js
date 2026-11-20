// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Per-request CORS state via AsyncLocalStorage. Replaces the previous
// module-scope `let _cors = {}` which had a race: concurrent requests on the
// same isolate could overwrite each other's CORS headers mid-flight. With
// AsyncLocalStorage, each request runs in its own store and `res()` reads the
// store from whichever async chain it's running in — never another request's.
import { AsyncLocalStorage } from 'node:async_hooks';

const corsStore = new AsyncLocalStorage();

// A request is trusted only when its Origin is this site's own address, so a
// self-hosted copy works on any domain with nothing to configure.
function ownOrigin(request) {
  try { return new URL(request.url).origin; } catch { return ''; }
}

function buildCors(request) {
  const origin = request?.headers?.get('Origin') || '';
  const own = ownOrigin(request);
  const allow = origin === own ? origin : own;
  return {
    'Access-Control-Allow-Origin': allow,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cookie',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
}

// Wraps the request handler so res() / corsPreflight() / response builders
// nested anywhere in the call chain pick up the right CORS headers.
export function withCors(request, fn) {
  return corsStore.run(buildCors(request), fn);
}

function getCors() {
  return corsStore.getStore() || {};
}

export function res(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    // API answers can hold resumes and account details: never cached, never type-sniffed.
    headers: { ...getCors(), 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders },
  });
}

export function corsPreflight() {
  return new Response(null, { status: 204, headers: getCors() });
}

export async function readJson(request) {
  // Content-Length can be absent on a chunked request, so the cap is enforced here too.
  let text;
  try { text = await request.text(); } catch { throw res({ error: 'Invalid JSON body' }, 400); }
  if (text.length > 200000) throw res({ error: 'Request too large' }, 413);
  try {
    return JSON.parse(text);
  } catch {
    throw res({ error: 'Invalid JSON body' }, 400);
  }
}

// One answer for every failed AI call. The visitor gets a fixed message, and the
// upstream detail (status, provider error text) goes to the log only.
export const AI_NOT_SET_UP = "AI isn't set up on this copy of Resume Prune yet. Whoever runs it needs to add an AI key.";
export function aiReady(env) {
  return !!env.ANTHROPIC_API_KEY;
}
export function aiNotSetUp() {
  return res({ error: AI_NOT_SET_UP, code: 'AI_NOT_SET_UP' }, 503);
}
export function aiFailure(e, fallback, where = 'ai') {
  if (e && e.code === 'NO_AI_KEY') return aiNotSetUp();
  console.error(`${where}: AI call failed`, (e && e.status) || '', (e && e.message) || e, (e && e.detail) || '');
  return res({ error: fallback }, 502);
}

// Billing return links must come from your own APP_URL, never a default address.
export function requireAppUrl(env) {
  if (!env.APP_URL) throw res({ error: 'Billing needs APP_URL set on this server.' }, 503);
  return env.APP_URL.replace(/\/+$/, '');
}

export function uuid() {
  return crypto.randomUUID();
}

export async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// free_samples keys: a salted sha256, so the stored hash can't be reversed by
// walking the IPv4 space or matched against a list of emails. Emails are
// trimmed + lowercased first so every caller lands on the same key.
export async function freeSampleHash(env, kind, value) {
  const v = kind === 'email' ? String(value || '').trim().toLowerCase() : String(value || '');
  return sha256Hex(`${env.JWT_SECRET || ''}|fs-${kind}|${v}`);
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP')
      || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
      || '0.0.0.0';
}

// CSRF defense-in-depth: verify the Origin (or Referer) of a state-changing
// request matches our allowlist. SameSite=Lax on the auth cookie is the
// primary defense; this is the belt-and-suspenders check for sensitive ops
// like account-delete, password-change, payment-method-change.
//
// Same-origin requests from our own pages will always set Origin to one of
// our domains. Cross-site form-submissions or fetches initiated by another
// site will either omit Origin or set it to the attacker's domain.
export function requireSameOrigin(request) {
  const method = request.method;
  // Only enforce on state-changing methods; reads + preflight are fine.
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  const origin = request.headers.get('Origin');
  if (origin) {
    if (origin === ownOrigin(request)) return null;
    return res({ error: 'Origin not allowed.' }, 403);
  }
  // Some browser legacy paths (e.g. file:// or strict-no-referrer) omit Origin.
  // Fall back to Referer if available; if both are absent, reject the mutation.
  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      if (refOrigin === ownOrigin(request)) return null;
    } catch { /* fall through */ }
    return res({ error: 'Origin not allowed.' }, 403);
  }
  return res({ error: 'Origin header required for this action.' }, 403);
}

// Generate a CSP nonce: 16 random bytes → base64.
// Used per-request so an XSS attempt can't pre-compute or replay a nonce.
export function makeCspNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, '');
}
