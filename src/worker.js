// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Resume Prune Worker
// Auth: PBKDF2 + HS256 JWT (with token_version revocation)
// Free sample flow + complete auth scaffolding
// Plans 2 (Pro experience) and 3 (Stripe + launch) extend this file.

import { res, withCors, corsPreflight, makeCspNonce } from './helpers.js';
import { reportServerError, alertPayloadFor, stripAlertHeader } from './lib/alert.js';
import { sampleAnalyze, sampleGenerate, sampleResult } from './routes/sample-routes.js';
import { signup, login, logout, verifyCode, resendCode, resetRequest, resetConfirm, changePassword, deleteAccount, exportAccount } from './routes/auth-routes.js';
import { getProfile, updateProfile, getProStatus, uploadResume, saveResume } from './routes/profile-routes.js';
import { tweakAnalyze, tweakGenerate, tweakList, tweakDetail, tweakDelete, tweakSetStatus, tweakRescore } from './routes/tweak-routes.js';
import { gapFillList, gapFillCreate, gapFillDelete } from './routes/gapfill-routes.js';
import { stripeCreateCheckout, stripeCreateCheckoutGuest, stripeClaimInfo, stripeClaim, stripeCreatePortal, stripeSyncSubscription, stripeWebhook, grantCompCode, revokeCompAccess } from './routes/stripe-routes.js';
import { unsubscribeGet, unsubscribePost } from './routes/unsubscribe-routes.js';
import { purgeExpired } from './lib/purge.js';
import { resumePageCreate, resumePageList, resumePagePatch, resumePageDelete, resumePagePublic } from './routes/pages-routes.js';

// CSP — strict by default, no `'unsafe-inline'` on scripts.
// Inline <script> blocks in HTML get a per-request nonce injected (see below)
// so they remain executable while blocking any attacker-injected inline JS.
function buildCsp(nonce) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://challenges.cloudflare.com`,
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    // Using the optional feedback widget? Add your webhook's origin here too.
    "connect-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ') + ';';
}

// Link-preview scrapers skip relative URLs, so a share tag written as
// content="/og.png" gets this site's APP_URL put in front of it at serve time.
// Tags that already hold a full address are left alone.
const SHARE_URL_TAG = /(<meta\s+(?:property|name)="(?:og:url|og:image|og:image:secure_url|twitter:image)"\s+content=")\/(?!\/)/g;
export function fillShareUrls(html, env) {
  const base = String(env.APP_URL || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) return html;
  return html.replace(SHARE_URL_TAG, `$1${base}/`);
}

// HSTS on every answer served over https, so browsers never retry this site over
// plain http. Skipped on http (local dev), where browsers ignore it anyway.
export function withHsts(request, response) {
  try {
    if (!response || new URL(request.url).protocol !== 'https:') return response;
    const out = new Response(response.body, response);
    out.headers.set('Strict-Transport-Security', 'max-age=31536000');
    return out;
  } catch { return response; }
}

export default {
  // Daily retention purge (wrangler.toml [triggers]). See src/lib/purge.js.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(purgeExpired(env).catch(e => console.error('daily purge failed', (e && e.message) || e)));
  },

  // Outer wrapper: any 5xx that leaves this worker fires an email beacon
  // (see lib/alert.js). This catches handled 502s (e.g. a Stripe API
  // rejection) as well as unhandled crashes — a real visitor hitting a
  // server error should never again be something we find out about later.
  //
  // Two exceptions, so test runs don't send alerts with no detail:
  //   - responses tagged by markNoAlert() (our own test traffic) are skipped
  //   - the alert now carries the error message, read off the response body
  // Reading the body happens inside waitUntil, so it never delays the client.
  async fetch(request, env, ctx) {
    // A THROW out of handle() has to become a Response before the 5xx branch
    // below can see it. Without this catch the exception escaped the worker,
    // the runtime turned it into its own 500, and NO alert email was sent —
    // silent on exactly the crash class the beacon exists for.
    let response;
    let errDetail = '';
    try {
      response = await this.handle(request, env, ctx);
    } catch (e) {
      console.error('unhandled route error', request.method, new URL(request.url).pathname, (e && e.stack) || e);
      response = new Response(JSON.stringify({ error: 'Server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
      // The message the beacon reads comes off this body, so name the cause.
      errDetail = String((e && e.message) || e).slice(0, 200);
    }
    try {
      if (response && response.status >= 500) {
        const job = alertPayloadFor(request, response, errDetail)
          .then(info => (info ? reportServerError(env, null, info) : null))
          .catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
      }
    } catch { /* never block the response */ }
    return withHsts(request, stripAlertHeader(response));
  },

  async handle(request, env, ctx) {
    return withCors(request, async () => {
      if (request.method === 'OPTIONS') return corsPreflight();

      const url = new URL(request.url);
      const p = url.pathname;

      // Worker-handled non-/api routes. Must come BEFORE the asset bypass.
      // The List-Unsubscribe header points mail apps at this same URL, and their
      // one-click button POSTs to it (RFC 8058). GET is the link in the email body.
      if (p === '/unsubscribe' && (request.method === 'GET' || request.method === 'POST')) {
        try { return await (request.method === 'POST' ? unsubscribePost(request, env) : unsubscribeGet(url, env)); }
        catch (e) {
          if (e instanceof Response) return e;
          console.error('unsubscribe handler crashed', e.stack || e);
          return new Response('Server error', { status: 500 });
        }
      }

      // Public hosted resume pages. Worker-handled (own HTML + headers), so it
      // must come BEFORE the asset bypass. Never throws — returns 404 HTML on miss.
      if (p.startsWith('/r/') && request.method === 'GET') {
        // A path that isn't valid percent-encoding (like /r/%) is just a link that
        // isn't live: empty slug, so it gets the same 404 page instead of a crash.
        let slug = '';
        try { slug = decodeURIComponent(p.slice('/r/'.length)); } catch { slug = ''; }
        try { return await resumePagePublic(request, env, slug); }
        catch (e) {
          if (e instanceof Response) return e;
          console.error('resume page handler crashed', e.stack || e);
          return new Response('Server error', { status: 500 });
        }
      }

      // Static assets bypass the API router and get hardened headers.
      if (!p.startsWith('/api/')) {
        // /claim/<session_id> is a virtual route — there is no such file, so
        // ASSETS would 404 it. Serve claim.html and let the page read the id off
        // the path. Requested without the .html so static assets does not 307 and
        // strip the id from the URL.
        const claimPath = p.match(/^\/claim\/(cs_[A-Za-z0-9_]{8,})\/?$/);
        const assetRequest = claimPath
          ? new Request(new URL('/claim', url).toString(), request)
          : request;
        const asset = await env.ASSETS.fetch(assetRequest);
        const ct = asset.headers.get('content-type') || '';
        const headers = new Headers(asset.headers);
        const nonce = makeCspNonce();
        let body = asset.body;

        // For HTML responses, inject the nonce into every <script> tag so the
        // existing inline scripts continue to run under strict CSP. We deliberately
        // add the nonce to src-scripts too — it's a no-op for them and keeps the
        // regex simple. Lookahead ensures we match tag boundaries, not <scripture>.
        if (ct.includes('text/html')) {
          const html = await asset.text();
          body = fillShareUrls(html, env).replace(/<script(?=[\s>])/gi, `<script nonce="${nonce}"`);
        }

        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('X-Frame-Options', 'DENY');
        headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
        headers.set('Content-Security-Policy', buildCsp(nonce));
        headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), usb=()');
        headers.set('Cache-Control', 'public, max-age=0, must-revalidate, no-cache');
        return new Response(body, { status: asset.status, headers });
      }

      // Stripe webhook: route BEFORE body-size check + auth so the raw body
      // (used for HMAC verification) is preserved. Stripe never sets Origin,
      // so CORS middleware is a no-op here.
      if (p === '/api/stripe/webhook' && request.method === 'POST') {
        try { return await stripeWebhook(request, env); }
        catch (e) {
          if (e instanceof Response) return e;
          console.error('stripe webhook handler crashed', e.stack || e);
          return res({ error: 'Server error' }, 500);
        }
      }

      // Internal comp-code minting (secret-verified, before auth/body checks).
      if (p === '/api/internal/comp-code' && request.method === 'POST') {
        try { return await grantCompCode(request, env); }
        catch (e) {
          if (e instanceof Response) return e;
          console.error('comp-code handler crashed', e.stack || e);
          return res({ error: 'Server error' }, 500);
        }
      }

      // Internal revoke of an affiliate-sourced grant (secret-verified).
      if (p === '/api/internal/revoke-access' && request.method === 'POST') {
        try { return await revokeCompAccess(request, env); }
        catch (e) {
          if (e instanceof Response) return e;
          console.error('revoke-access handler crashed', e.stack || e);
          return res({ error: 'Server error' }, 500);
        }
      }

      // API request size limit
      const cl = parseInt(request.headers.get('Content-Length') || '0');
      if (cl > 200000) return res({ error: 'Request too large' }, 413);

      try {
        // Routes filled in by later tasks. For now just a health check.
        if (p === '/api/health' && request.method === 'GET') {
          return res({ ok: true, app: 'resume-prune' });
        }
        // Public runtime config (only safe-to-expose values)
        if (p === '/api/config' && request.method === 'GET') {
          return res({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || null, billing: !!(env.STRIPE_SECRET_KEY && (env.STRIPE_PRICE_PRO || env.STRIPE_PRICE_SPRINT)) });
        }
        // NOTE: every route below uses `return await` so async rejections
        // (typed Response throws) are caught by the outer try/catch instead of
        // escaping to Cloudflare's top-level handler as a generic 500.
        if (p === '/api/sample/analyze' && request.method === 'POST') return await sampleAnalyze(request, env);
        if (p === '/api/sample/generate' && request.method === 'POST') return await sampleGenerate(request, env);
        // Public viewer for stored free-sample results (auto-expire 30d)
        if (p.startsWith('/api/sample/result/') && request.method === 'GET') {
          const id = p.slice('/api/sample/result/'.length);
          return await sampleResult(request, env, id);
        }
        if (p === '/api/auth/signup' && request.method === 'POST') return await signup(request, env);
        if (p === '/api/auth/login'  && request.method === 'POST') return await login(request, env);
        if (p === '/api/auth/logout' && request.method === 'POST') return await logout(request, env);
        if (p === '/api/auth/verify-code'  && request.method === 'POST') return await verifyCode(request, env);
        if (p === '/api/auth/resend-code'  && request.method === 'POST') return await resendCode(request, env);
        if (p === '/api/auth/reset-request' && request.method === 'POST') return await resetRequest(request, env, ctx);
        if (p === '/api/auth/reset-confirm' && request.method === 'POST') return await resetConfirm(request, env);
        if (p === '/api/auth/password'      && request.method === 'PUT')  return await changePassword(request, env);
        if (p === '/api/auth/account'       && request.method === 'DELETE') return await deleteAccount(request, env);
        if (p === '/api/account/export'     && request.method === 'GET')    return await exportAccount(request, env);
        if (p === '/api/unsubscribe'        && request.method === 'POST')   return await unsubscribePost(request, env);

        if (p === '/api/profile'    && request.method === 'GET')  return await getProfile(request, env);
        if (p === '/api/profile'    && request.method === 'PUT')  return await updateProfile(request, env);
        if (p === '/api/pro-status' && request.method === 'GET')  return await getProStatus(request, env);
        if (p === '/api/profile/upload-resume' && request.method === 'POST') return await uploadResume(request, env);
        if (p === '/api/profile/resume' && request.method === 'PUT') return await saveResume(request, env);

        if (p === '/api/tweak/analyze' && request.method === 'POST') return await tweakAnalyze(request, env);
        if (p === '/api/tweak/generate' && request.method === 'POST') return await tweakGenerate(request, env);

        if (p === '/api/stripe/create-checkout' && request.method === 'POST') return await stripeCreateCheckout(request, env);
        if (p === '/api/stripe/create-checkout-guest' && request.method === 'POST') return await stripeCreateCheckoutGuest(request, env);
        if (p === '/api/stripe/claim-info' && request.method === 'GET') return await stripeClaimInfo(request, env, url);
        if (p === '/api/stripe/claim' && request.method === 'POST') return await stripeClaim(request, env);
        if (p === '/api/stripe/create-portal'   && request.method === 'POST') return await stripeCreatePortal(request, env);
        if (p === '/api/stripe/sync'            && request.method === 'POST') return await stripeSyncSubscription(request, env);

        if (p === '/api/gap-fills' && request.method === 'GET')  return await gapFillList(request, env);
        if (p === '/api/gap-fills' && request.method === 'POST') return await gapFillCreate(request, env);
        if (p.startsWith('/api/gap-fills/') && request.method === 'DELETE') {
          const id = p.slice('/api/gap-fills/'.length);
          return await gapFillDelete(request, env, id);
        }

        if (p === '/api/resume-pages' && request.method === 'GET')  return await resumePageList(request, env);
        if (p === '/api/resume-pages' && request.method === 'POST') return await resumePageCreate(request, env);
        if (p.startsWith('/api/resume-pages/') && request.method === 'PATCH') {
          const id = p.slice('/api/resume-pages/'.length);
          return await resumePagePatch(request, env, id);
        }
        if (p.startsWith('/api/resume-pages/') && request.method === 'DELETE') {
          const id = p.slice('/api/resume-pages/'.length);
          return await resumePageDelete(request, env, id);
        }

        if (p === '/api/tweaks' && request.method === 'GET') return await tweakList(request, env);
        if (p.startsWith('/api/tweaks/') && p.endsWith('/rescore') && request.method === 'POST') {
          const id = p.slice('/api/tweaks/'.length, -'/rescore'.length);
          return await tweakRescore(request, env, id);
        }
        if (p.startsWith('/api/tweaks/') && request.method === 'GET') {
          const id = p.slice('/api/tweaks/'.length);
          return await tweakDetail(request, env, id);
        }
        if (p.startsWith('/api/tweaks/') && request.method === 'DELETE') {
          const id = p.slice('/api/tweaks/'.length);
          return await tweakDelete(request, env, id);
        }
        if (p.startsWith('/api/tweaks/') && request.method === 'PATCH') {
          const id = p.slice('/api/tweaks/'.length);
          return await tweakSetStatus(request, env, id);
        }

        return res({ error: 'Not found' }, 404);
      } catch (e) {
        if (e instanceof Response) return e;
        console.error(e.stack || e);
        return res({ error: 'Server error' }, 500);
      }
    });
  },
};
