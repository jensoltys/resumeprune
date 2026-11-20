// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Stripe helpers — webhook signature verification + thin API wrapper.
// We don't use the Stripe SDK (heavy for Workers); a few fetch calls cover us.
//
// Webhook security: Stripe signs every webhook with HMAC-SHA256 over
// `<timestamp>.<raw body>` using STRIPE_WEBHOOK_SECRET. We verify the
// signature AND a 5-minute timestamp skew so replay attacks can't reuse an
// old signed event. See https://stripe.com/docs/webhooks/signatures.

const STRIPE_API = 'https://api.stripe.com/v1';
const MAX_WEBHOOK_AGE_SEC = 5 * 60; // 5 minutes, matches Stripe's recommendation

const enc = new TextEncoder();

// Constant-time string equality. Prevents signature-timing attacks that could
// otherwise let an attacker probe the secret one byte at a time.
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Parses Stripe's `Stripe-Signature` header into { t, v1[] }.
// Format: `t=1234567890,v1=abc...,v1=def...,v0=...`
function parseSignatureHeader(header) {
  const out = { t: null, v1: [] };
  if (!header) return out;
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') out.t = v;
    else if (k === 'v1') out.v1.push(v);
  }
  return out;
}

// Verify webhook signature + recency. Returns { ok, event } or { ok: false, reason }.
// `rawBody` MUST be the exact string Stripe signed — do not re-stringify the
// parsed JSON, byte-for-byte differences will break verification.
export async function verifyWebhook(env, rawBody, sigHeader) {
  if (!env.STRIPE_WEBHOOK_SECRET) return { ok: false, reason: 'webhook-secret-not-configured' };
  if (!sigHeader) return { ok: false, reason: 'missing-signature' };

  const parsed = parseSignatureHeader(sigHeader);
  if (!parsed.t || parsed.v1.length === 0) return { ok: false, reason: 'malformed-signature' };

  // Reject events older than the skew window (replay defense).
  const ts = parseInt(parsed.t, 10);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_WEBHOOK_AGE_SEC) {
    return { ok: false, reason: 'timestamp-skew' };
  }

  const expected = await hmacSha256Hex(env.STRIPE_WEBHOOK_SECRET, `${parsed.t}.${rawBody}`);
  const match = parsed.v1.some(v => timingSafeEqual(v, expected));
  if (!match) return { ok: false, reason: 'signature-mismatch' };

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return { ok: false, reason: 'invalid-json' }; }

  return { ok: true, event };
}

// Map a Stripe price ID to a plan. Price IDs come from env (never accept
// client-supplied price IDs — that's the classic Stripe injection bug).
export function planForPriceId(env, priceId) {
  if (!priceId) return null;
  if (priceId === env.STRIPE_PRICE_PRO)    return 'pro';
  if (priceId === env.STRIPE_PRICE_SPRINT) return 'sprint';
  return null;
}

function rpPriceIds(env) {
  return [env.STRIPE_PRICE_PRO, env.STRIPE_PRICE_SPRINT].filter(Boolean);
}

// Explicit product guard: is this Stripe subscription a RESUME PRUNE one?
// Stripe fans every event out to EVERY endpoint on the account, so other
// products' invoices on the same account land here too. Affiliate attribution
// no longer sits behind the local user lookup (a first purchase has no user row
// yet), so this price check is the only thing stopping Resume Prune from
// recording a conversion for another product's sale (a double commission).
// Never remove it. Fails CLOSED when the price env vars are missing.
export function isResumePruneSub(sub, env) {
  const ids = rpPriceIds(env);
  if (!ids.length) return false;
  const items = sub?.items?.data || [];
  return items.some(it => ids.includes(it?.price?.id) || ids.includes(it?.plan?.id))
    || ids.includes(sub?.plan?.id);
}

// Same guard for the refund path, applied to the invoice a refunded charge
// points at. A Charge carries no line items, so the invoice is how a refund
// proves it is ours. It matters more than it looks: two products on one
// account can share a price, so an unguarded reversal can void the wrong
// product's commission and rob an affiliate of a commission they earned.
export function invoiceIsResumePrune(invoice, env) {
  const ids = rpPriceIds(env);
  if (!ids.length) return false;
  const lines = invoice?.lines?.data || [];
  return lines.some(l => ids.includes(l?.price?.id)
    || ids.includes(l?.plan?.id)
    || ids.includes(l?.pricing?.price_details?.price));
}

// Flatten nested params into Stripe's bracket notation, to ANY depth.
// The old version only flattened one level, so a doubly-nested value like
// subscription_data.metadata.aff_ref serialized as the literal string
// "[object Object]" and Stripe rejected the entire checkout — which broke
// checkout for every visitor arriving through an affiliate link. Exported
// for the pre-deploy param test.
export function buildFormBody(params, body = new URLSearchParams(), prefix = '') {
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item === undefined || item === null) return;
        if (typeof item === 'object') buildFormBody(item, body, `${key}[${i}]`);
        else body.append(`${key}[${i}]`, String(item));
      });
    } else if (typeof v === 'object') {
      buildFormBody(v, body, key);
    } else {
      body.append(key, String(v));
    }
  }
  return body;
}

// Stripe REST call. Stripe's API uses form-encoded bodies, not JSON.
async function stripeApi(env, method, path, params = {}, opts = {}) {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not configured');
  const body = buildFormBody(params);
  const headers = {
    'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  // Some endpoints (e.g. promotion_codes with a `coupon` param) need an API
  // version pin; the account default version rejects the param otherwise.
  if (opts.apiVersion) headers['Stripe-Version'] = opts.apiVersion;
  const resp = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : body.toString(),
  });
  const json = await resp.json();
  if (!resp.ok) {
    const msg = json?.error?.message || `Stripe API ${resp.status}`;
    const err = new Error(msg);
    err.stripe = json;
    throw err;
  }
  return json;
}

export async function createCheckoutSession(env, { customerId, customerEmail, priceId, successUrl, cancelUrl, clientReferenceId, affRef }) {
  // automatic_tax: Stripe works out sales tax / VAT from the buyer's address. Off
  // unless STRIPE_AUTOMATIC_TAX = "true". Turn on Stripe Tax first (head office
  // address set, status active), or Stripe rejects every checkout. Stripe Tax
  // charges a fee per transaction.
  //
  // payment_method_collection: 'if_required' means: when a 100%-off coupon
  // brings the subscription to $0 (a comp code), Stripe Checkout
  // skips card collection. Paying customers still see the normal card form.
  const params = {
    mode: 'subscription',
    customer: customerId || undefined,
    customer_email: customerId ? undefined : customerEmail,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: clientReferenceId,
    allow_promotion_codes: 'true',
    ...(env.STRIPE_AUTOMATIC_TAX === 'true' ? { automatic_tax: { enabled: 'true' } } : {}),
    payment_method_collection: 'if_required',
  };
  // Stamp the affiliate referral code onto the subscription so the webhook can
  // attribute every paid invoice to the affiliate (commission tracking).
  if (affRef) params.subscription_data = { metadata: { aff_ref: affRef } };
  return stripeApi(env, 'POST', '/checkout/sessions', params);
}

export async function createPortalSession(env, { customerId, returnUrl }) {
  return stripeApi(env, 'POST', '/billing_portal/sessions', {
    customer: customerId,
    return_url: returnUrl,
  });
}

export async function retrieveSubscription(env, subscriptionId) {
  return stripeApi(env, 'GET', `/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

// Retrieve an Invoice, PINNED to 2024-06-20. The pin is load-bearing: on the
// account's default API version an Invoice no longer exposes `charge` and a
// Charge no longer exposes `invoice`, so a refund loses the id that ties it back
// to the affiliate conversion row (conversions are keyed on the invoice id).
// At 2024-06-20 both still resolve. Only the refund path uses these — the
// webhook endpoint itself stays on the account default version, where
// `parent.subscription_details.subscription` is the load-bearing fallback.
export async function retrieveInvoice(env, invoiceId) {
  return stripeApi(env, 'GET', `/invoices/${encodeURIComponent(invoiceId)}`, {}, { apiVersion: '2024-06-20' });
}

// Retrieve a Charge, pinned for the same reason: the charge.refunded payload
// arrives at the account default version with no `invoice`, so we re-read the
// charge at a version that still carries it.
export async function retrieveCharge(env, chargeId) {
  return stripeApi(env, 'GET', `/charges/${encodeURIComponent(chargeId)}`, {}, { apiVersion: '2024-06-20' });
}

// Retrieve a Checkout Session by id. Used by the guest-checkout claim flow:
// the session id (from the success-URL redirect) acts as proof of purchase,
// and only sessions created with OUR secret key are retrievable here.
export async function retrieveCheckoutSession(env, sessionId) {
  return stripeApi(env, 'GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

// List a customer's subscriptions (newest first). Used to reconcile plan state
// directly from Stripe when a webhook was missed or arrived out of order — e.g.
// a $0 comp-code subscription where customer.subscription.created raced ahead of
// checkout.session.completed and never found the user row to update.
export async function listCustomerSubscriptions(env, customerId) {
  const out = await stripeApi(
    env, 'GET',
    `/subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=10`
  );
  return out?.data || [];
}

// Immediate subscription cancel (no period-end grace). Used by account-delete
// so a user can't be charged for a subscription tied to a row that no longer
// exists. If the subscription is already canceled or unknown, treat as success.
export async function cancelSubscription(env, subscriptionId) {
  try {
    return await stripeApi(env, 'DELETE', `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  } catch (e) {
    // Stripe returns 404 for already-deleted or invalid IDs; treat that as a no-op.
    if (e.stripe?.error?.code === 'resource_missing') return { ok: true, missing: true };
    throw e;
  }
}
