// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Affiliate Pro gifts for Resume Prune — time-boxed Pro access with NO Stripe
// subscription, so it can't interfere with real payments and auto-expires via
// plan_expires (see effectivePlan in usage.js). Times are epoch seconds.
import { nowSec } from '../helpers.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// "Forever" sentinel for lifetime comps: 2126-01-01T00:00:00Z.
// A fixed date, not a huge months number, so the 24-month clamp below keeps
// protecting every normal grant from fat-fingered input.
export const LIFETIME_EXP = 4922553600;

function expiryFromMonths(months) {
  const m = Number.isInteger(months) ? Math.min(24, Math.max(1, months)) : 6;
  const d = new Date();
  d.setMonth(d.getMonth() + m);
  return { exp: Math.floor(d.getTime() / 1000), months: m };
}

// Grant time-boxed Pro to an email. Records a pending grant (so it lands even if
// the Resume Prune account is created later) and applies it immediately when the
// account exists AND is not a paying customer. NEVER touches a paying customer
// (they already have Pro via Stripe; a gift would only confuse their state).
export async function grantProByEmail(env, email, months = 6, lifetime = false) {
  const e = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e) || e.length > 200) return { ok: false, error: 'bad_email' };
  const { exp, months: m } = lifetime === true
    ? { exp: LIFETIME_EXP, months: null }
    : expiryFromMonths(months);
  const now = nowSec();

  // Pending grant — keep the furthest-out expiry if one already exists.
  await env.DB.prepare(
    `INSERT INTO pro_grants (email, plan_expires, source, created_at, applied_at)
     VALUES (?1, ?2, 'affiliate', ?3, NULL)
     ON CONFLICT(email) DO UPDATE SET plan_expires=?2, created_at=?3, applied_at=NULL
       WHERE excluded.plan_expires > pro_grants.plan_expires`
  ).bind(e, exp, now).run();

  const user = await env.DB.prepare(
    'SELECT id, plan, plan_expires, stripe_subscription_id FROM users WHERE email = ?'
  ).bind(e).first();

  let granted = false, reason = null;
  if (user) {
    if (user.stripe_subscription_id) {
      // Paying customer — leave their Stripe-managed plan completely alone.
      await env.DB.prepare('UPDATE pro_grants SET applied_at=? WHERE email=?').bind(now, e).run();
      reason = 'paying_customer';
    } else {
      const current = Number(user.plan_expires) || 0;
      if (exp > current) {
        await env.DB.prepare('UPDATE users SET plan=?, plan_expires=?, updated_at=? WHERE id=?')
          .bind('pro', exp, now, user.id).run();
      }
      await env.DB.prepare('UPDATE pro_grants SET applied_at=? WHERE email=?').bind(now, e).run();
      granted = true;
    }
  }
  return { ok: true, granted, reason, account_exists: !!user, plan_expires: exp, months: m };
}

// Apply any unredeemed pending gift for this email to this user. Called on login
// + email verification so a gift issued before signup lands on first login.
// No-op for paying customers (Stripe owns their plan).
export async function applyPendingProGrant(env, userId, email) {
  const e = String(email || '').trim().toLowerCase();
  const g = await env.DB.prepare(
    'SELECT plan_expires FROM pro_grants WHERE email=? AND applied_at IS NULL'
  ).bind(e).first();
  if (!g) return;
  const u = await env.DB.prepare(
    'SELECT plan_expires, stripe_subscription_id FROM users WHERE id=?'
  ).bind(userId).first();
  const now = nowSec();
  if (u && !u.stripe_subscription_id) {
    const grantExp = Number(g.plan_expires) || 0;
    const current = Number(u.plan_expires) || 0;
    if (grantExp > current) {
      await env.DB.prepare('UPDATE users SET plan=?, plan_expires=?, updated_at=? WHERE id=?')
        .bind('pro', grantExp, now, userId).run();
    }
  }
  await env.DB.prepare('UPDATE pro_grants SET applied_at=? WHERE email=?').bind(now, e).run();
}

// Revoke an affiliate-sourced Pro grant. Grant-scoped: only clears access whose
// expiry still matches the grant we issued, so a purchase or a longer comp is
// never touched.
export async function revokeProByEmail(env, email) {
  const e = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e) || e.length > 200) return { ok: false, error: 'bad_email' };
  const grant = await env.DB.prepare(
    "SELECT plan_expires, applied_at FROM pro_grants WHERE email = ? AND source = 'affiliate'"
  ).bind(e).first();
  if (!grant) return { ok: true, revoked: false, reason: 'no_grant' };

  if (!grant.applied_at) {
    await env.DB.prepare("DELETE FROM pro_grants WHERE email = ? AND source = 'affiliate'").bind(e).run();
    return { ok: true, revoked: true, reason: 'pending_grant_deleted' };
  }
  const user = await env.DB.prepare(
    'SELECT id, plan_expires, stripe_subscription_id FROM users WHERE email = ?'
  ).bind(e).first();
  if (!user) {
    await env.DB.prepare("DELETE FROM pro_grants WHERE email = ? AND source = 'affiliate'").bind(e).run();
    return { ok: true, revoked: true, reason: 'no_account' };
  }
  if (user.stripe_subscription_id) return { ok: true, revoked: false, reason: 'paying_customer' };
  if (Number(user.plan_expires) !== Number(grant.plan_expires)) {
    return { ok: true, revoked: false, reason: 'access_not_from_grant' };
  }
  await env.DB.prepare("UPDATE users SET plan = 'free', plan_expires = NULL, updated_at = ? WHERE id = ?")
    .bind(nowSec(), user.id).run();
  await env.DB.prepare("DELETE FROM pro_grants WHERE email = ? AND source = 'affiliate'").bind(e).run();
  return { ok: true, revoked: true };
}
