// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Cloudflare Turnstile verification. Without TURNSTILE_SECRET_KEY every check fails, so a
// forgotten key can't leave your AI bill open. For local testing only, set ALLOW_NO_TURNSTILE=true.

import { clientIp } from '../helpers.js';

export async function verifyTurnstile(env, request, token) {
  if (!env.TURNSTILE_SECRET_KEY) {
    return env.ALLOW_NO_TURNSTILE === 'true' ? { ok: true, skipped: true } : { ok: false, reason: 'turnstile-not-configured' };
  }
  if (!token) return { ok: false, reason: 'missing-token' };

  const form = new URLSearchParams();
  form.append('secret', env.TURNSTILE_SECRET_KEY);
  form.append('response', token);
  form.append('remoteip', clientIp(request));

  let resp;
  try {
    resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
  } catch (e) {
    return { ok: false, reason: 'network', detail: String(e) };
  }
  if (!resp.ok) return { ok: false, reason: 'siteverify-status', detail: resp.status };

  const data = await resp.json().catch(() => null);
  if (!data || data.success !== true) {
    return { ok: false, reason: 'rejected', detail: data?.['error-codes']?.join(',') };
  }
  return { ok: true };
}
