// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
import { res, readJson, uuid, nowSec, requireSameOrigin, requireAppUrl } from '../helpers.js';
import { requireAuth, optionalAuth, hashPw, authCookie, issueSessionJwt } from '../auth.js';
import { rateLimit } from '../ratelimit.js';
import {
  verifyWebhook,
  planForPriceId,
  isResumePruneSub,
  invoiceIsResumePrune,
  createCheckoutSession,
  createPortalSession,
  retrieveSubscription,
  retrieveInvoice,
  retrieveCharge,
  retrieveCheckoutSession,
  listCustomerSubscriptions,
  cancelSubscription,
  timingSafeEqual,
} from '../lib/stripe.js';
import { grantProByEmail, revokeProByEmail } from '../lib/grants.js';
import { sendEmail, cancellationTemplate, purchaseWelcomeTemplate, duplicateCheckoutTemplate } from '../email.js';
import { sendClaimCode } from './auth-routes.js';

// Guest-checkout users get a sentinel pw_hash until they claim the account.
// checkPw() fails closed on any non-'pbkdf2:' prefix, so these rows can never
// log in until /api/stripe/claim swaps in a real hash.
const GUEST_PW_PREFIX = 'guest-checkout:';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A checkout session counts as settled when Stripe says it's paid — or
// no_payment_required (a 100%-off promo code brings the first invoice to $0).
function sessionSettled(session) {
  return session
    && session.mode === 'subscription'
    && (session.payment_status === 'paid' || session.payment_status === 'no_payment_required');
}

// Link a settled guest checkout session to a user row keyed by the email typed at
// checkout, creating the row (with an unusable sentinel password) if needed.
// Idempotent, safe to run from the webhook AND the claim endpoints in either order.
// Returns { user, created, duplicate } or null when the session isn't a usable
// Resume Prune purchase. Throws if Stripe can't be read, so the webhook retries.
//
// Stripe does NOT prove the buyer owns that email. So a
// guest purchase can only attach to a row nobody has verified yet (a guest row, or a
// signup still waiting on its code), or the row already bound to this subscription. Any other account is left completely alone: the
// webhook cancels the NEW subscription and tells the address. The claim endpoints
// never cancel anything (cancelDuplicate false), so an old claim link stays harmless.
async function linkGuestSessionToUser(env, session, { cancelDuplicate = false } = {}) {
  const email = String(session.customer_details?.email || session.customer_email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return null;
  if (!session.subscription) return null;
  // Product guard first: Stripe sends every product's checkouts to this endpoint.
  const sub = await retrieveSubscription(env, session.subscription);
  if (!isResumePruneSub(sub, env)) return null;
  const now = nowSec();
  const COLUMNS = 'id, email, pw_hash, email_verified, stripe_customer_id, stripe_subscription_id, stripe_status';

  let user = await env.DB.prepare(`SELECT ${COLUMNS} FROM users WHERE email = ?`).bind(email).first();
  let created = false;
  if (!user) {
    const id = uuid();
    // INSERT OR IGNORE closes the webhook-vs-claim race: if both fire at once,
    // one insert wins and the loser re-reads the winner's row.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, email, pw_hash, plan, newsletter_consent, email_verified, token_version, created_at, updated_at)
       VALUES (?, ?, ?, 'free', 0, 0, 0, ?, ?)`
    ).bind(id, email, GUEST_PW_PREFIX + uuid(), now, now).run();
    user = await env.DB.prepare(`SELECT ${COLUMNS} FROM users WHERE email = ?`).bind(email).first();
    created = user?.id === id;
  }
  if (!user) return null;

  if (user.stripe_subscription_id === session.subscription) {
    await applySubscriptionToUser(env, user.id, sub);
    return { user, created, duplicate: false };
  }

  // Check and bind in one statement, so two purchases can't both win the same row.
  const bound = await env.DB.prepare(
    `UPDATE users SET stripe_subscription_id = ?, stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_status = NULL, updated_at = ?
     WHERE id = ? AND email_verified = 0
       AND (stripe_subscription_id IS NULL
            OR stripe_subscription_id = ?
            OR (stripe_status IS NOT NULL AND stripe_status NOT IN ('active', 'trialing')))`
  ).bind(session.subscription, session.customer || null, now, user.id, session.subscription).run();

  if (!bound.meta?.changes) {
    // The webhook and the claim page can run at once. Never cancel on a stale read:
    // if this row holds this subscription now, this purchase is the one that won.
    const fresh = await env.DB.prepare('SELECT stripe_subscription_id FROM users WHERE id = ?').bind(user.id).first();
    if (fresh?.stripe_subscription_id === session.subscription) {
      await applySubscriptionToUser(env, user.id, sub);
      return { user, created, duplicate: false };
    }
    if (cancelDuplicate) {
      try {
        await cancelSubscription(env, session.subscription);
        console.error(`guest checkout: address already has an account, canceled NEW sub ${session.subscription} for user ${user.id}. Check whether the charge needs a refund.`);
      } catch (e) {
        console.error('guest checkout: duplicate sub cancel FAILED, manual cleanup needed', session.subscription, e.stripe || e.message);
      }
    }
    return { user, created: false, duplicate: true };
  }
  await applySubscriptionToUser(env, user.id, sub);
  return { user, created, duplicate: false };
}

// Claim-page wrapper: a Stripe hiccup reads as "try again", never a 500.
async function linkForClaim(env, session) {
  try {
    return await linkGuestSessionToUser(env, session);
  } catch (e) {
    console.error('claim: guest link failed', e.stripe || e.message);
    return null;
  }
}

// Stripe moved current_period_end OFF the Subscription object and onto each
// subscription item (Basil, 2025-03-31+). Reading the old top-level field
// returns undefined against the current API, which silently wrote
// plan_expires = NULL for every payer and left the cancellation email unable to
// name an access-until date.
// Keep the top-level fallback for older pinned calls and replayed events.
function periodEndOf(sub) {
  return Number(sub?.items?.data?.[0]?.current_period_end)
    || Number(sub?.current_period_end)
    || null;
}

// Purchase-confirmation email. Best-effort: a mail failure must never 5xx the
// webhook (Stripe would retry the whole event and re-run the plan writes).
// Reads the plan back from the DB so the email states what the user ACTUALLY
// got, not what we assumed from the price.
async function sendPurchaseWelcome(env, { userId, email, session, unclaimed }) {
  try {
    if (!email) return;
    const row = await env.DB.prepare('SELECT plan FROM users WHERE id = ?').bind(userId).first();
    const plan = row?.plan;
    if (!plan || plan === 'free') return; // nothing was actually granted; stay quiet
    const base = (env.APP_URL || '').replace(/\/+$/, '');
    // PATH segment, not ?session_id= . This link goes in an EMAIL, and
    // quoted-printable encoding eats the `=` plus the next two characters in
    // transit — the claim page would open with no session and a paying customer
    // could not claim what they just bought. (The Stripe successUrl below keeps
    // its query string: that is a browser redirect Stripe requires, never email.)
    const claimUrl = unclaimed && session?.id
      ? `${base}/claim/${encodeURIComponent(session.id)}`
      : null;
    const tpl = purchaseWelcomeTemplate({ plan, claimUrl, dashboardUrl: `${base}/app.html` });
    await sendEmail(env, { to: email, ...tpl });
  } catch (e) {
    console.error('purchase welcome email failed', e.stripe || e.message);
  }
}

// Write a Stripe subscription's plan state onto a user row. Shared by the
// webhook (subscription.created/updated, invoice.paid), the checkout.session
// .completed handler, and the live /api/stripe/sync reconcile path so the
// active-status gate and column set never drift between them.
// A subscription only counts as a paid plan while 'active' or 'trialing';
// anything else (past_due, unpaid, canceled, incomplete) reads as free.
async function applySubscriptionToUser(env, userId, sub) {
  if (!userId || !sub) return null;
  const priceId = sub.items?.data?.[0]?.price?.id;
  const plan = planForPriceId(env, priceId);
  if (!plan) return null; // unknown price → don't touch the row
  const status = sub.status;
  const effectivePlan = (status === 'active' || status === 'trialing') ? plan : 'free';
  await env.DB.prepare(
    `UPDATE users SET plan = ?, plan_expires = ?, stripe_subscription_id = ?, stripe_status = ?, updated_at = ? WHERE id = ?`
  ).bind(effectivePlan, periodEndOf(sub), sub.id, status, nowSec(), userId).run();
  return effectivePlan;
}

// From a list of a customer's subscriptions, pick the one that should drive the
// plan: prefer an active/trialing one, else the most recently created.
function pickPlanSubscription(subs) {
  if (!subs || !subs.length) return null;
  const live = subs.filter(s => s.status === 'active' || s.status === 'trialing');
  const pool = live.length ? live : subs;
  return pool.reduce((a, b) => ((b.created || 0) > (a.created || 0) ? b : a));
}

// POST /api/internal/comp-code  (X-Internal-Secret)  body: { email, months? }
// Affiliate Pro gift. Was: mint a 100%-off-FOREVER Stripe promo code redeemed at
// checkout (a real $0 subscription). Now: grant time-boxed (default 6-month) Pro
// directly, with NO Stripe subscription — so it can't interfere with real
// payments and auto-expires. Never touches a paying customer. coupon_code is
// always null, kept so older callers of this route don't break.
export async function grantCompCode(request, env) {
  const rl = await rateLimit(request, env, 'comp-code', 20, 60); // 20/min/IP
  if (rl) return rl;
  const secret = request.headers.get('X-Internal-Secret') || '';
  if (!env.RESUME_COMP_SECRET || !timingSafeEqual(secret, env.RESUME_COMP_SECRET)) {
    return res({ error: 'Unauthorized' }, 401);
  }
  const body = await readJson(request).catch(() => ({}));
  const months = Number.isInteger(body?.months) ? body.months : 6;
  const lifetime = body?.lifetime === true; // lifetime comps: expiry pinned to 2126, bypasses the 24-month clamp
  const email = String(body?.email || '').trim().toLowerCase();
  if (!email) return res({ error: 'email required' }, 400);
  try {
    const r = await grantProByEmail(env, email, months, lifetime);
    if (!r.ok) return res({ error: 'Could not grant Pro' }, 400);
    return res({ ok: true, granted: r.granted, account_exists: r.account_exists, plan_expires: r.plan_expires, months: r.months, coupon_code: null });
  } catch (e) {
    console.error('grantCompCode (grant) failed', e.message);
    return res({ error: 'Could not grant Pro' }, 502);
  }
}

// POST /api/internal/revoke-access  { email }  (X-Internal-Secret)
export async function revokeCompAccess(request, env) {
  const rl = await rateLimit(request, env, 'revoke-access', 20, 60); // 20/min/IP
  if (rl) return rl;
  const secret = request.headers.get('X-Internal-Secret') || '';
  if (!env.RESUME_COMP_SECRET || !timingSafeEqual(secret, env.RESUME_COMP_SECRET)) {
    return res({ error: 'Unauthorized' }, 401);
  }
  const body = await readJson(request).catch(() => ({}));
  const email = String(body?.email || '').trim().toLowerCase();
  if (!email) return res({ error: 'email required' }, 400);
  try {
    const r = await revokeProByEmail(env, email);
    if (!r.ok) return res({ error: 'Could not revoke' }, 400);
    return res(r);
  } catch (e) {
    console.error('revokeCompAccess failed', e.message);
    return res({ error: 'Could not revoke' }, 502);
  }
}

// POST /api/stripe/create-checkout  body: { plan: 'pro' | 'sprint' }
// Returns { url } — frontend redirects window.location to it.
// Server-side price-ID whitelist (NEVER trust client-supplied price IDs).
export async function stripeCreateCheckout(request, env) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  // No Stripe on this copy: say so plainly instead of a checkout that can't work.
  if (!env.STRIPE_SECRET_KEY || (!env.STRIPE_PRICE_PRO && !env.STRIPE_PRICE_SPRINT)) return res({ error: "Paid plans aren't set up on this copy of Resume Prune. Pro is available on the hosted version at resumeprune.com." }, 404);
  const uid = await requireAuth(request, env);
  const rl = await rateLimit(request, env, 'stripe-checkout', 10, 60, `uid:${uid}:stripe-checkout`);
  if (rl) return rl;

  const body = await readJson(request);
  const plan = body.plan === 'pro' ? 'pro' : body.plan === 'sprint' ? 'sprint' : null;
  if (!plan) throw res({ error: 'plan must be "pro" or "sprint".' }, 400);
  // Affiliate referral code (from ?ref, persisted client-side) -> Stripe subscription
  // metadata, so the webhook can attribute paid invoices to the affiliate.
  const affRef = String(body.ref || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40);

  const priceId = plan === 'pro' ? env.STRIPE_PRICE_PRO : env.STRIPE_PRICE_SPRINT;
  if (!priceId) return res({ error: "Paid plans aren't set up on this copy of Resume Prune. Pro is available on the hosted version at resumeprune.com." }, 404);

  const user = await env.DB.prepare(
    `SELECT id, email, stripe_customer_id FROM users WHERE id = ?`
  ).bind(uid).first();
  if (!user) throw res({ error: 'User not found' }, 404);

  const base = requireAppUrl(env);
  let session;
  try {
    session = await createCheckoutSession(env, {
      customerId: user.stripe_customer_id || null,
      customerEmail: user.stripe_customer_id ? null : user.email,
      priceId,
      successUrl: `${base}/account?upgraded=1&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/account?canceled=1`,
      clientReferenceId: user.id, // webhook uses this to find our user
      affRef: affRef || undefined,
    });
  } catch (e) {
    console.error('Stripe checkout create failed', e.stripe || e.message);
    throw res({ error: 'Could not start checkout. Try again in a minute.' }, 502);
  }

  return res({ url: session.url });
}

// POST /api/stripe/create-checkout-guest  body: { plan: 'pro' | 'sprint', ref? }
// Checkout-first: no account needed. Stripe Checkout collects the email; the
// webhook + /claim attach the subscription to an account afterwards. If the
// caller happens to be logged in, fall back to the normal authed checkout so
// their session lands on their existing account.
export async function stripeCreateCheckoutGuest(request, env) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  // No Stripe on this copy: say so plainly instead of a checkout that can't work.
  if (!env.STRIPE_SECRET_KEY || (!env.STRIPE_PRICE_PRO && !env.STRIPE_PRICE_SPRINT)) return res({ error: "Paid plans aren't set up on this copy of Resume Prune. Pro is available on the hosted version at resumeprune.com." }, 404);

  const uid = await optionalAuth(request, env);
  if (uid) return stripeCreateCheckout(request, env);

  const rl = await rateLimit(request, env, 'stripe-checkout-guest', 10, 3600);
  if (rl) return rl;

  const body = await readJson(request);
  const plan = body.plan === 'pro' ? 'pro' : body.plan === 'sprint' ? 'sprint' : null;
  if (!plan) throw res({ error: 'plan must be "pro" or "sprint".' }, 400);
  const affRef = String(body.ref || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40);

  const priceId = plan === 'pro' ? env.STRIPE_PRICE_PRO : env.STRIPE_PRICE_SPRINT;
  if (!priceId) return res({ error: "Paid plans aren't set up on this copy of Resume Prune. Pro is available on the hosted version at resumeprune.com." }, 404);

  const base = requireAppUrl(env);
  let session;
  try {
    session = await createCheckoutSession(env, {
      customerId: null,
      customerEmail: null, // Stripe Checkout collects it
      priceId,
      successUrl: `${base}/claim?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/#pricing-section`,
      clientReferenceId: undefined,
      affRef: affRef || undefined,
    });
  } catch (e) {
    console.error('Stripe guest checkout create failed', e.stripe || e.message);
    throw res({ error: 'Could not start checkout. Try again in a minute.' }, 502);
  }
  return res({ url: session.url });
}

// GET /api/stripe/claim-info?session_id=cs_...
// Post-payment state for the /claim page. The session id from the Stripe
// success redirect is the bearer proof of purchase (only the payer's browser
// has it, and only sessions created with our key resolve).
export async function stripeClaimInfo(request, env, url) {
  const rl = await rateLimit(request, env, 'stripe-claim-info', 20, 3600);
  if (rl) return rl;

  const sessionId = String(url.searchParams.get('session_id') || '');
  if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(sessionId)) return res({ error: 'Invalid session.' }, 400);

  let session;
  try {
    session = await retrieveCheckoutSession(env, sessionId);
  } catch (e) {
    return res({ error: 'We could not find that checkout. If you were charged, email support@example.com.' }, 404);
  }
  if (!sessionSettled(session)) {
    return res({ error: 'This checkout has not completed. If you were charged, email support@example.com.' }, 409);
  }

  // Make sure the entitlement is attached even if the webhook hasn't landed yet.
  const linked = await linkForClaim(env, session);
  if (!linked) return res({ error: 'We could not read the email from your checkout. Email support@example.com.' }, 422);

  if (linked.duplicate) return res({ email: linked.user.email, state: 'duplicate' });
  const claimable = linked.user.pw_hash.startsWith(GUEST_PW_PREFIX);
  const plan = await env.DB.prepare('SELECT plan FROM users WHERE id = ?').bind(linked.user.id).first();
  return res({
    email: linked.user.email,
    plan: plan?.plan || 'free',
    state: claimable ? 'claimable' : 'account_exists',
  });
}

// POST /api/stripe/claim  body: { session_id, password }
// Finish a guest checkout: set the real password on the sentinel account and
// log the buyer in. Never overwrites a pre-existing password — a paid session
// id must not be able to take over an established account.
export async function stripeClaim(request, env) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const rl = await rateLimit(request, env, 'stripe-claim', 10, 3600);
  if (rl) return rl;

  const body = await readJson(request);
  const sessionId = String(body.session_id || '');
  const password = String(body.password || '');
  if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(sessionId)) return res({ error: 'Invalid session.' }, 400);
  if (password.length < 10) return res({ error: 'Password must be at least 10 characters.' }, 400);
  if (password.length > 200) return res({ error: 'Password too long.' }, 400);

  let session;
  try {
    session = await retrieveCheckoutSession(env, sessionId);
  } catch (e) {
    return res({ error: 'We could not find that checkout.' }, 404);
  }
  if (!sessionSettled(session)) return res({ error: 'This checkout has not completed.' }, 409);

  const linked = await linkForClaim(env, session);
  if (!linked) return res({ error: 'We could not read the email from your checkout. Email support@example.com.' }, 422);

  if (linked.duplicate) return res({ ok: false, duplicate: true, email: linked.user.email }, 409);
  if (!linked.user.pw_hash.startsWith(GUEST_PW_PREFIX)) {
    // Established account — plan is attached (above); password stays theirs.
    return res({ ok: false, account_exists: true, email: linked.user.email }, 409);
  }

  const pw = await hashPw(password);
  // Guard the sentinel in the WHERE so two concurrent claims can't both win,
  // and a claim can never overwrite a password set through any other path.
  const upd = await env.DB.prepare(
    `UPDATE users SET pw_hash = ?, updated_at = ?
     WHERE id = ? AND pw_hash LIKE '${GUEST_PW_PREFIX}%'`
  ).bind(pw, nowSec(), linked.user.id).run();
  if (!upd.meta || upd.meta.changes === 0) {
    return res({ ok: false, account_exists: true, email: linked.user.email }, 409);
  }

  // Stripe doesn't prove the buyer owns this address, so the account opens only
  // after the emailed code (POST /api/auth/verify-code), same as a normal signup.
  const emailSent = await sendClaimCode(env, linked.user.id, linked.user.email);
  return res({ ok: true, awaiting_verification: true, email: linked.user.email, email_sent: emailSent });
}

// POST /api/stripe/create-portal — returns { url } to Stripe customer portal
// for managing subscription (update card, cancel, view invoices).
export async function stripeCreatePortal(request, env) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  // No Stripe on this copy: say so plainly instead of a checkout that can't work.
  if (!env.STRIPE_SECRET_KEY) return res({ error: "Billing isn't set up on this copy of Resume Prune." }, 404);
  const uid = await requireAuth(request, env);
  const rl = await rateLimit(request, env, 'stripe-portal', 10, 60, `uid:${uid}:stripe-portal`);
  if (rl) return rl;

  const user = await env.DB.prepare(
    `SELECT stripe_customer_id FROM users WHERE id = ?`
  ).bind(uid).first();
  if (!user) throw res({ error: 'User not found' }, 404);
  if (!user.stripe_customer_id) {
    throw res({ error: 'No subscription yet. Pick a plan to get started.' }, 412);
  }

  const base = requireAppUrl(env);
  let session;
  try {
    session = await createPortalSession(env, {
      customerId: user.stripe_customer_id,
      returnUrl: `${base}/account`,
    });
  } catch (e) {
    console.error('Stripe portal create failed', e.stripe || e.message);
    throw res({ error: 'Could not open billing portal. Try again in a minute.' }, 502);
  }
  return res({ url: session.url });
}

// POST /api/stripe/sync — reconcile the logged-in user's plan directly from
// Stripe. Self-heals any webhook that was missed or arrived out of order (the
// $0 comp-code race). Only ever touches the caller's own customer, so it's safe
// to call on every account-page load. Auth + same-origin + rate-limited.
export async function stripeSyncSubscription(request, env) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const uid = await requireAuth(request, env);
  const rl = await rateLimit(request, env, 'stripe-sync', 20, 60, `uid:${uid}:stripe-sync`);
  if (rl) return rl;

  const user = await env.DB.prepare(
    `SELECT id, plan, stripe_customer_id FROM users WHERE id = ?`
  ).bind(uid).first();
  if (!user) throw res({ error: 'User not found' }, 404);

  // No Stripe customer yet → nothing to reconcile; report current DB plan.
  if (!user.stripe_customer_id) {
    return res({ plan: user.plan || 'free', synced: false });
  }

  try {
    const subs = await listCustomerSubscriptions(env, user.stripe_customer_id);
    const sub = pickPlanSubscription(subs);
    if (!sub) {
      // Customer exists but has no subscriptions → ensure they read as free.
      if (user.plan !== 'free') {
        await env.DB.prepare(
          `UPDATE users SET plan = 'free', plan_expires = NULL, updated_at = ? WHERE id = ?`
        ).bind(nowSec(), uid).run();
      }
      return res({ plan: 'free', synced: true });
    }
    const effectivePlan = await applySubscriptionToUser(env, uid, sub);
    return res({ plan: effectivePlan || user.plan || 'free', synced: true });
  } catch (e) {
    console.error('stripe sync failed', e.stripe || e.message);
    // Don't surface a hard error to the account page — fall back to DB plan.
    return res({ plan: user.plan || 'free', synced: false });
  }
}

// POST /api/stripe/webhook — raw body, signature in header.
// Idempotent via UNIQUE constraint on payment_events.stripe_event_id.
//
// Events we handle:
// - checkout.session.completed → save stripe_customer_id on the user row (first link)
// - customer.subscription.created → flip plan + plan_expires
// - customer.subscription.updated → re-sync plan + plan_expires (re-uses same logic)
// - customer.subscription.deleted → revert to free
// - invoice.paid → bump plan_expires (renewal)
// - invoice.payment_failed → no plan change, just log (Stripe will retry; eventually subscription.deleted fires if it can't recover)
export async function stripeWebhook(request, env) {
  const rawBody = await request.text();
  const sig = request.headers.get('Stripe-Signature');

  const v = await verifyWebhook(env, rawBody, sig);
  if (!v.ok) {
    console.error('Stripe webhook verify failed:', v.reason);
    // 400 (not 401) per Stripe convention — they retry on 5xx, give up on 4xx.
    return res({ error: 'Invalid signature' }, 400);
  }
  const event = v.event;
  const eventId = event.id;
  const type = event.type;

  // Idempotency lock — LOCK-FIRST. Atomically claim the event id
  // BEFORE running any side effects. Stripe delivers at-least-once and can fire the
  // same event concurrently; the old "record-after-processing" order let two parallel
  // replays both pass and both run the side effects. INSERT OR IGNORE on a PRIMARY KEY
  // makes the first writer win: if no row was inserted (meta.changes === 0) this is a
  // duplicate/replay, so we 200 immediately without re-processing.
  // NOTE: keyed in its own `webhook_events` table (not `payment_events`, whose user_id
  // is NOT NULL and isn't known until dispatch) so the lock can be truly pre-flight.
  try {
    const lock = await env.DB.prepare(
      `INSERT OR IGNORE INTO webhook_events (stripe_event_id, event_type, created_at)
       VALUES (?, ?, ?)`
    ).bind(eventId, type, nowSec()).run();
    if (!lock.meta || lock.meta.changes === 0) {
      // Already seen (concurrent or replayed delivery) → no-op, tell Stripe to stop.
      return res({ received: true, duplicate: true });
    }
  } catch (e) {
    console.error('webhook idempotency lock failed', e.message);
    // Fail closed toward Stripe retry (500) so we don't silently drop a real event
    // when the dedup store is unavailable.
    return res({ error: 'Internal' }, 500);
  }

  // user_id is determined per event-type below; we update it after dispatch.
  let userId = null;
  let amount = null;
  let currency = null;

  try {
    if (type === 'checkout.session.completed') {
      const session = event.data.object;
      const customerId = session.customer;
      // client_reference_id is only ours when it names a real account. Other
      // checkouts on the same Stripe account (a payment link tagged with a label,
      // like the repo's tip link) carry their own text here. Those aren't Resume
      // Prune purchases, so they're acknowledged and left alone, never treated as
      // a guest checkout.
      const refId = session.client_reference_id || null;
      let refSub = null;
      if (refId) {
        const known = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(refId).first();
        if (!known) return res({ received: true, ignored: 'unknown-client-reference' });
        // A real account id is not enough. A payment link takes client_reference_id
        // straight from its URL, so anyone can put someone's account id on a tip or
        // on another product's checkout. Only a session whose subscription is on one
        // of OUR prices may touch that account's Stripe links.
        if (session.mode !== 'subscription' || !session.subscription) {
          return res({ received: true, ignored: 'not-resume-prune' });
        }
        refSub = await retrieveSubscription(env, session.subscription);
        if (!isResumePruneSub(refSub, env)) return res({ received: true, ignored: 'not-resume-prune' });
        userId = refId;
      }
      if (!userId) {
        // Guest checkout (checkout-first flow): no user existed when the session
        // was created. Attach by the email Stripe collected — creating a sentinel
        // account the /claim page finishes. Idempotent with the claim endpoint.
        if (sessionSettled(session)) {
          const linked = await linkGuestSessionToUser(env, session, { cancelDuplicate: true });
          if (linked?.duplicate) {
            try {
              await sendEmail(env, { to: linked.user.email, ...duplicateCheckoutTemplate({ loginUrl: `${env.APP_URL}/login` }) });
            } catch (e) { console.error('duplicate checkout email failed', e.message); }
          } else if (linked) {
            userId = linked.user.id;
            await sendPurchaseWelcome(env, {
              userId,
              email: linked.user.email,
              session,
              // Only offer the claim link while the account is still unclaimed.
              // Re-read: linkGuestSessionToUser may have raced the /claim endpoint.
              unclaimed: String(linked.user.pw_hash || '').startsWith(GUEST_PW_PREFIX),
            });
          }
        }
      }
      else if (userId && customerId) {
        await env.DB.prepare(
          `UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?`
        ).bind(customerId, nowSec(), userId).run();
        // Set the plan here too, not just in customer.subscription.created.
        // For $0 comp-code subscriptions the two events fire near-simultaneously
        // and out of order; if subscription.created lands first it can't find the
        // user (the customer link above hasn't been written yet) and the plan is
        // never set. We always have the user here (client_reference_id), so pull
        // the subscription and apply it — this is the authoritative race-closer.
        // refSub was read (and price-checked) above.
        try {
          await applySubscriptionToUser(env, userId, refSub);
        } catch (e) {
          console.error('checkout.session.completed: sub apply failed', e.stripe || e.message);
        }
        // Logged-in buyer: account already exists, so no claim step.
        const u = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first();
        if (u?.email) await sendPurchaseWelcome(env, { userId, email: u.email, session, unclaimed: false });
      }
    }
    else if (type === 'customer.subscription.created' || type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const customerId = sub.customer;
      const u = await env.DB.prepare(
        `SELECT id, email FROM users WHERE stripe_customer_id = ?`
      ).bind(customerId).first();
      if (u) {
        userId = u.id;
        await applySubscriptionToUser(env, userId, sub);
        // Email once when a cancel is scheduled (Stripe portal "cancel" sets
        // cancel_at_period_end). previous_attributes fires this only on the
        // false->true transition, not on every update. Best-effort.
        const prev = event.data.previous_attributes || {};
        if (sub.cancel_at_period_end === true && prev.cancel_at_period_end === false && u.email) {
          try {
            const tpl = cancellationTemplate({ scheduled: true, accessUntil: periodEndOf(sub), manageUrl: `${(env.APP_URL || '').replace(/\/+$/, '')}/account.html` });
            await sendEmail(env, { to: u.email, ...tpl });
          } catch (e) { console.error('RP cancellation(scheduled) email failed', e.message); }
        }
      }
      // If no user row matches yet (customer link not written — the race above),
      // checkout.session.completed will set the plan from the subscription, so we
      // safely skip here rather than create an orphaned update.
    }
    else if (type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const customerId = sub.customer;
      const u = await env.DB.prepare(
        `SELECT id, email, stripe_subscription_id FROM users WHERE stripe_customer_id = ?`
      ).bind(customerId).first();
      // Only the subscription this account runs on can end its plan. Another
      // product's subscription on the same Stripe customer must not.
      if (u && (!u.stripe_subscription_id || u.stripe_subscription_id === sub.id)) {
        userId = u.id;
        await env.DB.prepare(
          `UPDATE users SET plan = 'free', plan_expires = NULL, stripe_status = ?, updated_at = ? WHERE id = ?`
        ).bind(sub.status || 'canceled', nowSec(), userId).run();
        if (u.email) {
          try {
            const tpl = cancellationTemplate({ scheduled: false, manageUrl: `${(env.APP_URL || '').replace(/\/+$/, '')}/account.html` });
            await sendEmail(env, { to: u.email, ...tpl });
          } catch (e) { console.error('RP cancellation(ended) email failed', e.message); }
        }
      }
    }
    else if (type === 'invoice.paid') {
      const inv = event.data.object;
      const customerId = inv.customer;
      amount = inv.amount_paid || null;
      currency = inv.currency || null;
      // Newer Stripe API versions moved the subscription ref off the invoice top
      // level into parent.subscription_details (line-item fallback). Reading only
      // inv.subscription left this undefined → no renewal sync, no affiliate
      // conversion. Resolve from all known locations (back-compatible).
      const subId = inv.subscription
        || inv.parent?.subscription_details?.subscription
        || inv.lines?.data?.[0]?.parent?.subscription_item_details?.subscription;
      const u = await env.DB.prepare(
        `SELECT id FROM users WHERE stripe_customer_id = ?`
      ).bind(customerId).first();
      if (u) userId = u.id;
      // Pull fresh sub to get the new current_period_end (don't trust invoice fields).
      //
      // NOTE the guard is `subId` alone, NOT `userId && subId`. It used to require
      // the user row, and that silently dropped affiliate commissions: on a FIRST
      // purchase `users.stripe_customer_id` is only written by
      // checkout.session.completed, and Stripe does not guarantee event order —
      // both events fire about a second apart. If invoice.paid won the race the
      // lookup returned nothing, the whole block was skipped, and we returned 200
      // so Stripe never retried. The affiliate's first commission on that customer
      // (the one that matters most for trust) vanished with no error anywhere.
      // Attribution never needed the local user: aff_ref lives on the subscription
      // metadata and the product identity comes from the price. The plan update
      // below still requires userId — that one genuinely does.
      if (subId) {
        try {
          const sub = await retrieveSubscription(env, subId);
          // Product guard FIRST. Now that attribution runs without the user
          // lookup, this price check is the only thing keeping Resume Prune from
          // recording a conversion for another product's sale that Stripe
          // fanned out to this endpoint. See isResumePruneSub.
          if (!isResumePruneSub(sub, env)) return res({ received: true, ignored: 'not-resume-prune' });
          const priceId = sub.items?.data?.[0]?.price?.id;
          const plan = planForPriceId(env, priceId);
          if (userId && plan && (sub.status === 'active' || sub.status === 'trialing')) {
            await env.DB.prepare(
              `UPDATE users SET plan = ?, plan_expires = ?, stripe_subscription_id = ?, stripe_status = ?, updated_at = ? WHERE id = ?`
            ).bind(plan, periodEndOf(sub), sub.id, sub.status, nowSec(), userId).run();
          }
          // Attribute the paid invoice to the affiliate (aff_ref was stamped on the
          // subscription at checkout). Cross-zone direct call to the affiliate
          // platform; idempotent on the invoice id; only real revenue.
          const affRef = sub.metadata?.aff_ref;
          // Optional: set AFFILIATE_API_URL to your own affiliate platform. Unset = skipped.
          if (affRef && env.AFFILIATE_API_URL && (inv.amount_paid || 0) > 0) {
            try {
              const rc = await fetch(env.AFFILIATE_API_URL + '/record-conversion', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': env.CONVERSION_WEBHOOK_SECRET || '' },
                body: JSON.stringify({
                  referral_code: affRef,
                  product_slug: 'resume-prune',
                  sale_amount_cents: inv.amount_paid,
                  currency: inv.currency,
                  stripe_invoice_id: inv.id,
                  stripe_charge_id: inv.charge,
                  stripe_subscription_id: sub.id,
                  customer_email: inv.customer_email || '',
                  attribution_method: 'referral_code',
                  status: 'pending',
                }),
              });
              // Log the platform's answer. This call used to be fire-and-forget,
              // which made a dropped commission invisible from this side: an auth
              // failure or a silent "skipped" read exactly like success. A real sale
              // never being credited is the worst failure this handler has, so it
              // gets a log line either way.
              const out = await rc.json().catch(() => null);
              if (rc.ok && out?.created) console.log('record-conversion ok', inv.id, out.created);
              else console.error('record-conversion NOT recorded', rc.status, inv.id, JSON.stringify(out));
            } catch (e) { console.error('record-conversion call failed', e.message); }
          }
        } catch (e) {
          console.error('invoice.paid: retrieveSubscription failed', e.stripe || e.message);
        }
      }
    }
    else if (type === 'charge.refunded') {
      // Refund → claw back the affiliate commission for that payment. Cross-zone
      // direct call to the affiliate platform; idempotent (matches the conversion
      // by the stored Stripe id). Mirrors the invoice.paid record-conversion forward.
      //
      // This fires for EVERY refunded charge on the whole Stripe account, so it
      // must prove the charge is ours before reversing anything. Two steps:
      //   1. Resolve the invoice. The event arrives at the account default API
      //      version, where a Charge no longer carries `invoice`, so re-read the
      //      charge pinned to 2024-06-20 (see retrieveCharge).
      //   2. Price-guard that invoice. Without it, another product's refund
      //      reverses a Resume Prune commission and vice versa.
      // We deliberately do NOT send customer_email: the affiliate platform falls
      // back to matching on buyer email + amount, and two products on one Stripe
      // account can share a price — that fallback can void the wrong
      // product's row. An unmatched refund is logged loudly instead of guessed at.
      const charge = event.data.object;
      try {
        let invoiceId = charge.invoice || '';
        if (!invoiceId && charge.id) {
          try {
            const full = await retrieveCharge(env, charge.id);
            invoiceId = full?.invoice || '';
          } catch (e) { console.error('charge.refunded: retrieveCharge failed', e.stripe || e.message); }
        }
        if (!invoiceId) {
          console.error('charge.refunded: UNRESOLVED — no invoice id for charge', charge.id,
            '— affiliate commission NOT reversed, check manually');
        } else {
          const invoice = await retrieveInvoice(env, invoiceId);
          if (!env.AFFILIATE_API_URL || !invoiceIsResumePrune(invoice, env)) {
            // Another product's refund, fanned out to this endpoint. Not ours.
          } else {
            const r = await fetch(env.AFFILIATE_API_URL + '/reverse-conversion', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': env.CONVERSION_WEBHOOK_SECRET || '' },
              body: JSON.stringify({
                stripe_invoice_id: invoiceId,
                stripe_charge_id: charge.id || '',
                stripe_payment_intent: charge.payment_intent || '',
                amount_refunded_cents: charge.amount_refunded ?? charge.amount ?? null,
                reason: 'Stripe charge.refunded (resume-prune)',
              }),
            });
            const out = await r.json().catch(() => null);
            // 'not_found' is the normal case for a non-affiliate sale (most of
            // them), so don't cry wolf on it — log it plainly. Anything else that
            // failed to reverse is a real problem worth an error line.
            if (r.ok && out?.skipped === 'not_found') {
              console.log('charge.refunded: no affiliate conversion for invoice', invoiceId);
            } else if (!r.ok || !(out?.reversed || out?.skipped === 'already_reversed')) {
              console.error('charge.refunded: reverse-conversion did not reverse a row for invoice',
                invoiceId, JSON.stringify(out));
            }
          }
        }
      } catch (e) { console.error('reverse-conversion call failed', e.stripe || e.message); }
    }
    else if (type === 'invoice.payment_failed') {
      // No plan change — Stripe will retry. If it ultimately fails, subscription.deleted fires.
      const inv = event.data.object;
      const customerId = inv.customer;
      const u = await env.DB.prepare(
        `SELECT id FROM users WHERE stripe_customer_id = ?`
      ).bind(customerId).first();
      if (u) userId = u.id;
    }
    // Unhandled types fall through and just get logged below.

    // Per-user audit log (amount/currency for receipts + affiliate accounting).
    // Idempotency is handled by the lock-first webhook_events claim above; this row
    // keeps its own UNIQUE(stripe_event_id) as a belt-and-suspenders guard against a
    // double-write, so a duplicate here is expected to silently no-op.
    if (userId) {
      try {
        await env.DB.prepare(
          `INSERT INTO payment_events (id, user_id, stripe_event_id, event_type, amount, currency, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(uuid(), userId, eventId, type, amount, currency, nowSec()).run();
      } catch (e) {
        // Duplicate stripe_event_id → already processed → fine.
        if (!String(e.message || '').includes('UNIQUE')) {
          console.error('payment_events insert failed', e.message);
        }
      }
    }
  } catch (e) {
    console.error(`stripe-webhook ${type} failed`, e.stack || e.message);
    // Release the idempotency lock, or Stripe's retry would be skipped as a duplicate.
    try {
      await env.DB.prepare('DELETE FROM webhook_events WHERE stripe_event_id = ?').bind(eventId).run();
    } catch (e2) { console.error('webhook lock release failed', e2.message); }
    // Return 500 so Stripe retries — but only for unexpected errors, not for
    // verification failures (handled above with 400).
    return res({ error: 'Internal' }, 500);
  }

  return res({ received: true });
}
