// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Usage period helpers for plan gating.
// - Pro      → calendar month   ("2026-05")
// - Sprint   → ISO week          ("2026-W19")
// - Free     → calendar month, but planLimit('free') returns 0 so it never advances
//
// All times treated in UTC for stability across DST and travel. Real-world drift
// of a few hours at month/week boundaries is acceptable for usage gating.

export const PLAN_LIMITS = Object.freeze({
  pro: 40,
  sprint: 20,
  free: 0,
  // A copy with paid plans switched off. There is nothing to buy, so every
  // account gets everything and the count never runs out.
  open: 1000000,
});

export function planLimit(plan) {
  return PLAN_LIMITS[plan] ?? 0;
}

// The plan a user is ACTUALLY entitled to right now.
// - Paying customers (have a Stripe subscription): trust `plan` exactly as today.
//   Stripe webhooks keep it current (active->plan, cancel->free), so there is no
//   expiry check and therefore NO risk of a renewal-window lockout for payers.
// - Gifted access (affiliate 6-month Pro, NO Stripe sub): honor `plan_expires`
//   (epoch seconds). Once it passes, the gift reverts to free even though the
//   `plan` column still reads 'pro' (nothing flips it without a webhook).
// `free` is always free. Pass a row with at least { plan, plan_expires,
// stripe_subscription_id }.
export function billingOn(env) {
  return !!(env.STRIPE_SECRET_KEY && (env.STRIPE_PRICE_PRO || env.STRIPE_PRICE_SPRINT));
}

// Pass env from a route. With paid plans off on this copy the answer is always
// 'open': no plan needed, nothing to upsell.
export function effectivePlan(user, env) {
  if (env && !billingOn(env)) return 'open';
  const plan = user?.plan || 'free';
  if (plan === 'free') return 'free';
  if (user?.stripe_subscription_id) return plan;       // paying — unchanged path
  const exp = Number(user?.plan_expires) || 0;          // gifted — expires
  return exp > Math.floor(Date.now() / 1000) ? plan : 'free';
}

export function isUnderLimit(plan, used) {
  return used < planLimit(plan);
}

export function periodKeyFor(plan, when = new Date()) {
  if (plan === 'sprint') return isoWeekKey(when);
  return monthKey(when);
}

function pad2(n) { return String(n).padStart(2, '0'); }

function monthKey(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

// ISO 8601 week-numbering year + week. Algorithm per Wikipedia "ISO week date".
function isoWeekKey(d) {
  // Copy date in UTC and shift to nearest Thursday: ISO week 1 contains the year's first Thursday.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7; // Mon=1..Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad2(weekNum)}`;
}
