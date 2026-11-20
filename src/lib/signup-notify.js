// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Optional operator signup ping. Set SIGNUP_WEBHOOK_URL and N8N_SIGNUP_WEBHOOK_SECRET
// to get a POST on each signup. Never throws and never fails a signup.
export function notifySignup(env, appName, email, appNewsletterConsent) {
  if (!env.N8N_SIGNUP_WEBHOOK_SECRET || !env.SIGNUP_WEBHOOK_URL) return Promise.resolve();
  return fetch(env.SIGNUP_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signup-Secret': env.N8N_SIGNUP_WEBHOOK_SECRET,
    },
    body: JSON.stringify({
      app_name: appName,
      email: (email || '').toLowerCase(),
      app_newsletter_consent: !!appNewsletterConsent,
      ss_newsletter_consent: false,
      timestamp: new Date().toISOString(),
    }),
    // Bounded so a hung webhook can never stall the signup response.
    signal: AbortSignal.timeout(5000),
  }).then(() => {}).catch(() => {});
}
