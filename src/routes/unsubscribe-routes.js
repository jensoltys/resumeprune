// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// One-click unsubscribe handler. CAN-SPAM requires this to work without login
// and be honored within 10 business days; we honor instantly.
//
// Supports both:
//   GET  /unsubscribe?u=<token>  → HTML confirmation page (link in email body)
//   POST /unsubscribe?u=<token>  → RFC 8058 List-Unsubscribe-Post one-click (the header URL)
//   POST /api/unsubscribe        → same handler, older path

import { verifyUnsubscribeToken, recordOptOut } from '../lib/unsubscribe.js';
import { sha256Hex, nowSec } from '../helpers.js';

function htmlPage({ title, heading, body, ok }) {
  const color = ok ? '#8FE0A8' : '#FFD36E';
  const bg = ok ? 'rgba(127,216,155,.1)' : 'rgba(255,211,110,.08)';
  const border = ok ? '#4F8F66' : '#8A6A2A';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/shared/styles.css">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=2">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<script src="/shared/theme.js"></script>
</head>
<body>
<main>
<div class="card" style="margin-top:32px;background:${bg};border:1px solid ${border};color:${color}">
<h1 style="font-family:var(--font-head);margin:0 0 12px">${heading}</h1>
${body}
<p style="margin-top:18px"><a href="/" style="color:${color};font-weight:700">Back to Resume Prune</a></p>
</div>
</main>
<script src="/shared/footer.js"></script>
</body></html>`;
}

async function flipUserConsent(env, emailHash) {
  // Compute hash for each user to find a match. O(N) scan — acceptable at
  // Resume Prune scale (<10K users). If we hit 100K, add users.email_hash
  // column with an index.
  const { results } = await env.DB.prepare('SELECT id, email FROM users WHERE newsletter_consent = 1').all();
  for (const u of (results || [])) {
    if (await sha256Hex(u.email) === emailHash) {
      await env.DB.prepare('UPDATE users SET newsletter_consent = 0, updated_at = ? WHERE id = ?')
        .bind(nowSec(), u.id).run();
      return true;
    }
  }
  return false;
}

// GET /unsubscribe?u=<token>
// HTML confirmation page rendered to the browser.
export async function unsubscribeGet(url, env) {
  const token = url.searchParams.get('u') || '';
  const emailHash = await verifyUnsubscribeToken(env, token);
  if (!emailHash) {
    return new Response(htmlPage({
      title: 'Unsubscribe link expired',
      heading: 'Link not valid',
      body: '<p>This unsubscribe link could not be verified. It may have been mangled by your email client. Email <strong>privacy@example.com</strong> and we will remove you manually.</p>',
      ok: false,
    }), { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  await recordOptOut(env, emailHash, 'unsubscribe-link');
  await flipUserConsent(env, emailHash);

  return new Response(htmlPage({
    title: 'Unsubscribed',
    heading: "You're unsubscribed",
    body: "<p>You won't get product update emails from Resume Prune anymore. Emails you need still come through, like account codes, password resets, billing notes and free-sample results you ask for.</p>",
    ok: true,
  }), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// POST /api/unsubscribe
// RFC 8058 one-click handler. Gmail / Apple Mail call this when the user hits
// their native Unsubscribe button. Returns 200 OK with empty body.
export async function unsubscribePost(request, env) {
  const url = new URL(request.url);
  let token = url.searchParams.get('u') || '';
  if (!token && request.headers.get('Content-Type')?.includes('application/x-www-form-urlencoded')) {
    const body = await request.text();
    const params = new URLSearchParams(body);
    token = params.get('u') || '';
  }
  const emailHash = await verifyUnsubscribeToken(env, token);
  if (!emailHash) {
    return new Response('Invalid token', { status: 400 });
  }
  await recordOptOut(env, emailHash, 'unsubscribe-post');
  await flipUserConsent(env, emailHash);
  return new Response('', { status: 200 });
}
