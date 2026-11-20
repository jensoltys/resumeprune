// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// node scripts/test-guest-checkout.mjs  --  guest checkout can't touch what an address already has,
// a claim needs the emailed code, and reset links die together.
// Real migrations on an in-memory node:sqlite database. Stripe and email are stubbed, nothing leaves this machine.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
const R = join(dirname(fileURLToPath(import.meta.url)), '..');

// The app logs its own errors while these tests force failures on purpose. Those
// lines (and their stack traces) read like a broken run, so they stay out of the
// output. Set TEST_VERBOSE=1 to see them. FAIL lines always print.
if (!process.env.TEST_VERBOSE) {
  const realError = console.error, realLog = console.log;
  console.error = (...a) => { if (/^(FAIL|\s*✗)/.test(String(a[0]))) realError(...a); };
  console.log = (...a) => { if (!/^(\{"evt"|\[dev\])/.test(String(a[0]))) realLog(...a); };
}

const db = new DatabaseSync(':memory:');
for (const f of readdirSync(join(R, 'migrations')).sort()) db.exec(readFileSync(join(R, 'migrations', f), 'utf8'));
const stmt = (sql, args = []) => ({
  sql,
  bind: (...a) => stmt(sql, a),
  first: async () => db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
});
const DB = { prepare: sql => stmt(sql), batch: async list => Promise.all(list.map(s => /^\s*SELECT/i.test(s.sql) ? s.all() : s.run())) };

const PRO = 'price_pro', SPRINT = 'price_sprint', OTHER = 'price_other_product';
const subs = {}, sessions = {}, canceled = [], mail = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)), method = init.method || 'GET';
  if (u.hostname === 'api.resend.com') { mail.push(JSON.parse(init.body)); return new Response('{"id":"m"}', { status: 200 }); }
  let m;
  if ((m = u.pathname.match(/^\/v1\/subscriptions\/(.+)$/))) {
    if (method === 'DELETE') { canceled.push(m[1]); return new Response(JSON.stringify({ id: m[1], status: 'canceled' }), { status: 200 }); }
    return new Response(JSON.stringify(subs[m[1]]), { status: 200 });
  }
  if ((m = u.pathname.match(/^\/v1\/checkout\/sessions\/(.+)$/))) return new Response(JSON.stringify(sessions[m[1]]), { status: 200 });
  return new Response('{}', { status: 200 });
};

const env = { DB, JWT_SECRET: 'test-secret-test-secret-test-secret-1234', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x',
  STRIPE_PRICE_PRO: PRO, STRIPE_PRICE_SPRINT: SPRINT, RESEND_API_KEY: 'x', APP_URL: 'https://resumeprune.com' };
const { stripeWebhook, stripeClaim, stripeClaimInfo } = await import(join(R, 'src/routes/stripe-routes.js'));
const auth = await import(join(R, 'src/routes/auth-routes.js'));
const { issueToken } = await import(join(R, 'src/lib/tokens.js'));
const { hashPw } = await import(join(R, 'src/auth.js'));

let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log('PASS ', label); } else { fail++; console.error('FAIL ', label, extra ?? ''); } };
const user = email => db.prepare('SELECT * FROM users WHERE email = ?').get(email);
const now = Math.floor(Date.now() / 1000);
let ip = 0;
const post = (path, body) => new Request('https://resumeprune.com' + path, { method: 'POST',
  headers: { Origin: 'https://resumeprune.com', 'Content-Type': 'application/json', 'CF-Connecting-IP': `10.0.0.${++ip % 250}` }, body: JSON.stringify(body) });
let evt = 0;
const hook = (type, object) => hookWith(env, type, object);
const hookWith = (useEnv, type, object) => {
  const raw = JSON.stringify({ id: `evt_${++evt}`, type, data: { object } }), t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex');
  return stripeWebhook(new Request('https://resumeprune.com/api/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${sig}` }, body: raw }), useEnv);
};
const buy = (id, email, price, customer = `cus_${id}`) => {
  subs[`sub_${id}`] = { id: `sub_${id}`, status: 'active', customer, items: { data: [{ price: { id: price }, current_period_end: now + 86400 }] } };
  return sessions[`cs_test_${id}aaaaaaaa`] = { id: `cs_test_${id}aaaaaaaa`, mode: 'subscription', payment_status: 'paid', customer, subscription: `sub_${id}`, customer_details: { email } };
};
const seed = async (email, fields = {}) => {
  const id = 'u_' + email.split('@')[0], f = { pw_hash: await hashPw('a-real-password'), plan: 'free', email_verified: 1, stripe_customer_id: null, stripe_subscription_id: null, stripe_status: null, ...fields };
  db.prepare(`INSERT INTO users (id, email, pw_hash, plan, email_verified, token_version, stripe_customer_id, stripe_subscription_id, stripe_status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(id, email, f.pw_hash, f.plan, f.email_verified, f.stripe_customer_id, f.stripe_subscription_id, f.stripe_status, now, now);
  return id;
};

// 1. A new buyer gets the plan, but the account opens only with the emailed code.
let s = buy('new1', 'new@example.com', SPRINT);
await hook('checkout.session.completed', s);
let u = user('new@example.com');
ok('new buyer: plan applied', u?.plan === 'sprint', u);
ok('new buyer: address not treated as verified', u?.email_verified === 0);
let r = await stripeClaim(post('/api/stripe/claim', { session_id: s.id, password: 'a-long-password-1' }), env);
let d = await r.json();
ok('claim asks for the code', r.status === 200 && d.awaiting_verification === true, d);
ok('claim gives no session', !r.headers.get('Set-Cookie'));
ok('claim leaves address unverified', user('new@example.com').email_verified === 0);
const code = (mail.at(-1).text + mail.at(-1).html).match(/\b\d{6}\b/)?.[0];
ok('claim emails a code', !!code);
r = await auth.verifyCode(post('/api/auth/verify-code', { email: 'new@example.com', code, password: 'a-long-password-1' }), env);
ok('the code opens the account', r.status === 200 && !!r.headers.get('Set-Cookie'), r.status);
ok('address is verified after the code', user('new@example.com').email_verified === 1);

// 2. Someone checks out with an address that already has a live plan.
await seed('victim@example.com', { plan: 'pro', stripe_customer_id: 'cus_victim', stripe_subscription_id: 'sub_victim', stripe_status: 'active' });
s = buy('evil', 'victim@example.com', SPRINT);
canceled.length = 0; mail.length = 0;
await hook('checkout.session.completed', s);
u = user('victim@example.com');
ok('duplicate: existing subscription not canceled', !canceled.includes('sub_victim'), canceled);
ok('duplicate: new subscription canceled', canceled.includes('sub_evil'), canceled);
ok('duplicate: plan and Stripe links unchanged', u.plan === 'pro' && u.stripe_customer_id === 'cus_victim' && u.stripe_subscription_id === 'sub_victim', u);
ok('duplicate: owner is told, no welcome', mail.length === 1 && /wasn't changed/.test(mail[0].subject), mail.map(m => m.subject));
r = await stripeClaim(post('/api/stripe/claim', { session_id: s.id, password: 'a-long-password-2' }), env);
ok('duplicate: claim refused', r.status === 409 && (await r.json()).duplicate === true);
r = await stripeClaimInfo(new Request(`https://resumeprune.com/api/stripe/claim-info?session_id=${s.id}`), env, new URL(`https://resumeprune.com/api/stripe/claim-info?session_id=${s.id}`));
ok('duplicate: claim page told', (await r.json()).state === 'duplicate');

// 2b. An unclaimed paid row can't be taken over by a second buyer.
s = buy('first', 'unclaimed@example.com', PRO); await hook('checkout.session.completed', s);
const before = user('unclaimed@example.com').pw_hash;
s = buy('second', 'unclaimed@example.com', SPRINT); await hook('checkout.session.completed', s);
r = await stripeClaim(post('/api/stripe/claim', { session_id: s.id, password: 'a-long-password-3' }), env);
ok('second buyer cannot claim a paid row', r.status === 409 && user('unclaimed@example.com').pw_hash === before);

// 3. Another product's checkout on the same Stripe account.
s = buy('other', 'stranger@example.com', OTHER); await hook('checkout.session.completed', s);
ok('other product: no account created', !user('stranger@example.com'));

// 3b. The repo's tip link (a Stripe Payment Link tagged client_reference_id=github-resumeprune)
// fans out here too. It isn't a Resume Prune purchase: acknowledged, nothing created or charged
// against an account, and never a 5xx that makes Stripe retry.
mail.length = 0; canceled.length = 0;
const usersBefore = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
r = await hook('checkout.session.completed', { id: 'cs_test_tipaaaaaaaa', mode: 'payment', payment_status: 'paid',
  client_reference_id: 'github-resumeprune', customer: null, subscription: null, customer_details: { email: 'tipper@example.com' } });
ok('tip link: acknowledged with 200', r.status === 200, r.status);
ok('tip link: no account, no mail, nothing canceled', !user('tipper@example.com') && db.prepare('SELECT COUNT(*) AS c FROM users').get().c === usersBefore && !mail.length && !canceled.length);
ok('tip link: no payment row against a made-up user id', !db.prepare("SELECT 1 FROM payment_events WHERE user_id = 'github-resumeprune'").get());
subs.sub_tipsub = { id: 'sub_tipsub', status: 'active', customer: 'cus_tip', items: { data: [{ price: { id: OTHER } }] } };
r = await hook('checkout.session.completed', { id: 'cs_test_tipsubaaaaaaaa', mode: 'subscription', payment_status: 'paid',
  client_reference_id: 'github-resumeprune', customer: 'cus_tip', subscription: 'sub_tipsub', customer_details: { email: 'tipper@example.com' } });
ok('tip link as a subscription: 200, still no account', r.status === 200 && !user('tipper@example.com') && !mail.length);

// 4. Only this account's own subscription can end its plan.
await hook('customer.subscription.deleted', { id: 'sub_unrelated', customer: 'cus_victim', status: 'canceled' });
ok('unrelated subscription ending changes nothing', user('victim@example.com').plan === 'pro');
await hook('customer.subscription.deleted', { id: 'sub_victim', customer: 'cus_victim', status: 'canceled' });
ok('its own subscription ending downgrades', user('victim@example.com').plan === 'free');

// 5. One reset kills every other reset link.
const rid = await seed('reset@example.com');
const t1 = await issueToken(env, rid, 'reset', 3600), t2 = await issueToken(env, rid, 'reset', 3600);
r = await auth.resetConfirm(post('/api/auth/reset-password', { token: t1, password: 'a-new-password-1' }), env);
ok('reset works', r.status === 200, r.status);
r = await auth.resetConfirm(post('/api/auth/reset-password', { token: t2, password: 'a-new-password-2' }), env);
ok('older reset link is dead', r.status === 400, r.status);

// 6. A signup code survives 4 wrong guesses, and the 5th burns it.
const cid = await seed('codes@example.com', { email_verified: 0, pw_hash: await hashPw('the-right-password') });
const { issueVerifyCode } = await import(join(R, 'src/lib/tokens.js'));
const guess = (c, password = 'the-right-password') => auth.verifyCode(post('/api/auth/verify-code', { email: 'codes@example.com', code: c, password }), env);
let real = await issueVerifyCode(env, cid, 1800);
const wrong = real === '000000' ? '000001' : '000000';
for (let i = 0; i < 4; i++) await guess(wrong);
db.prepare("DELETE FROM rate_limits WHERE key LIKE 'verify-code:%'").run();
r = await guess(real);
ok('the right code still works after 4 wrong guesses', r.status === 200, r.status);
db.prepare('UPDATE users SET email_verified = 0 WHERE id = ?').run(cid);
real = await issueVerifyCode(env, cid, 1800);
db.prepare("DELETE FROM rate_limits WHERE key LIKE 'verify-miss:%'").run();
const wrong2 = real === '000000' ? '000001' : '000000';
for (let i = 0; i < 5; i++) await guess(wrong2);
db.prepare("DELETE FROM rate_limits WHERE key LIKE 'verify-code:%'").run();
r = await guess(real);
ok('after 5 wrong guesses the code is dead', r.status === 400, r.status);

// 7. Established accounts are untouched by a guest purchase, even with no live plan.
await seed('gifted@example.com', { plan: 'pro' });
db.prepare("UPDATE users SET plan_expires = ? WHERE email = 'gifted@example.com'").run(now + 86400);
s = buy('gift', 'gifted@example.com', SPRINT); canceled.length = 0;
await hook('checkout.session.completed', s);
u = user('gifted@example.com');
ok('gifted account unchanged', u.plan === 'pro' && !u.stripe_customer_id && !u.stripe_subscription_id, u);
ok('that purchase is canceled', canceled.includes('sub_gift'), canceled);

// 7b. Someone who started signing up, then paid, keeps the plan they bought.
await seed('halfway@example.com', { email_verified: 0 });
s = buy('half', 'halfway@example.com', PRO); canceled.length = 0;
await hook('checkout.session.completed', s);
ok('unverified signup gets the plan', user('halfway@example.com').plan === 'pro' && !canceled.length, canceled);

// 7c. Webhook and claim page racing: a stale read must not cancel the buyer's own purchase.
s = buy('race', 'race@example.com', SPRINT);
await stripeClaimInfo(new Request(`https://resumeprune.com/x?session_id=${s.id}`), env, new URL(`https://resumeprune.com/x?session_id=${s.id}`));
const stale = { ...user('race@example.com'), stripe_subscription_id: null, stripe_status: null };
const staleEnv = { ...env, DB: { ...DB, prepare: sql => /FROM users WHERE email = \?/.test(sql) ? { bind: () => ({ first: async () => stale }) } : DB.prepare(sql) } };
canceled.length = 0;
await hookWith(staleEnv, 'checkout.session.completed', s);
ok('racing webhook keeps the purchase', !canceled.length && user('race@example.com').stripe_subscription_id === 'sub_race', canceled);

// 7d. Without the row's password, guesses can't burn the code.
const pid = await seed('pw@example.com', { email_verified: 0, pw_hash: await hashPw('the-right-password') });
const pcode = await issueVerifyCode(env, pid, 1800), pwrong = pcode === '000000' ? '000001' : '000000';
for (let i = 0; i < 6; i++) await auth.verifyCode(post('/api/auth/verify-code', { email: 'pw@example.com', code: pwrong, password: 'not-the-password' }), env);
db.prepare("DELETE FROM rate_limits WHERE key LIKE 'verify-code:%'").run();
r = await auth.verifyCode(post('/api/auth/verify-code', { email: 'pw@example.com', code: pcode, password: 'the-right-password' }), env);
ok('owner code survives guesses without the password', r.status === 200, r.status);

// 8. Opening an old claim link cancels nothing.
s = buy('oldlink', 'victim2@example.com', SPRINT);
await seed('victim2@example.com', { plan: 'pro', stripe_customer_id: 'cus_v2', stripe_subscription_id: 'sub_v2', stripe_status: 'active' });
canceled.length = 0;
await stripeClaimInfo(new Request(`https://resumeprune.com/x?session_id=${s.id}`), env, new URL(`https://resumeprune.com/x?session_id=${s.id}`));
ok('claim page cancels nothing', canceled.length === 0, canceled);

// 9. A failed webhook can be retried.
s = buy('retry', 'retry@example.com', SPRINT); const keep = subs.sub_retry; delete subs.sub_retry;
const id = `evt_${evt + 1}`;
r = await hook('checkout.session.completed', s);
ok('Stripe failure returns 500', r.status === 500, r.status);
ok('the event lock is released', !db.prepare('SELECT 1 FROM webhook_events WHERE stripe_event_id = ?').get(id));
subs.sub_retry = keep;

// 10. A real account id on someone else's checkout changes nothing on that account.
// A payment link takes client_reference_id from its URL, so anyone can type one in.
const tid = await seed('target@example.com', { plan: 'pro', stripe_customer_id: 'cus_target', stripe_subscription_id: 'sub_target', stripe_status: 'active' });
mail.length = 0;
r = await hook('checkout.session.completed', { id: 'cs_test_tipidaaaaaaaa', mode: 'payment', payment_status: 'paid',
  client_reference_id: tid, customer: 'cus_tipper', subscription: null, customer_details: { email: 'tipper@example.com' } });
u = user('target@example.com');
ok('tip with a real account id: 200 and Stripe links unchanged', r.status === 200 && u.stripe_customer_id === 'cus_target' && u.stripe_subscription_id === 'sub_target' && u.plan === 'pro', u);
subs.sub_otherprod = { id: 'sub_otherprod', status: 'active', customer: 'cus_elsewhere', items: { data: [{ price: { id: OTHER } }] } };
r = await hook('checkout.session.completed', { id: 'cs_test_otheridaaaaaaaa', mode: 'subscription', payment_status: 'paid',
  client_reference_id: tid, customer: 'cus_elsewhere', subscription: 'sub_otherprod', customer_details: { email: 'x@example.com' } });
u = user('target@example.com');
ok("another product's checkout with a real account id: unchanged, no mail", r.status === 200 && u.stripe_customer_id === 'cus_target' && u.stripe_subscription_id === 'sub_target' && !mail.length, u);
ok('no payment row logged against that account', !db.prepare("SELECT 1 FROM payment_events WHERE user_id = ? AND event_type = 'checkout.session.completed'").get(tid));
// The real thing still works: a logged-in buyer's own checkout on our price.
const lid = await seed('loggedin@example.com');
subs.sub_logged = { id: 'sub_logged', status: 'active', customer: 'cus_logged', items: { data: [{ price: { id: PRO }, current_period_end: now + 86400 }] } };
r = await hook('checkout.session.completed', { id: 'cs_test_loggedaaaaaaaa', mode: 'subscription', payment_status: 'paid',
  client_reference_id: lid, customer: 'cus_logged', subscription: 'sub_logged', customer_details: { email: 'loggedin@example.com' } });
u = user('loggedin@example.com');
ok('logged-in checkout on our price still applies the plan', r.status === 200 && u.plan === 'pro' && u.stripe_customer_id === 'cus_logged' && u.stripe_subscription_id === 'sub_logged', u);

// 11. A flood of sign-ups can't use up the codes paying buyers are waiting for.
const day = new Date().toISOString().slice(0, 10);
db.prepare("INSERT INTO daily_counts (k, day, n) VALUES ('mail:verify', ?, 150) ON CONFLICT(k, day) DO UPDATE SET n = 150").run(day);
mail.length = 0;
r = await auth.signup(post('/api/auth/signup', { email: 'late-signup@example.com', password: 'a-long-password-9' }), env);
ok('sign-up cap reached: no sign-up mail goes out', r.status === 200 && mail.length === 0, mail.length);
const claimsBefore = db.prepare("SELECT n FROM daily_counts WHERE k = 'mail:claim' AND day = ?").get(day)?.n || 0;
s = buy('capbuyer', 'capbuyer@example.com', SPRINT);
await hook('checkout.session.completed', s);
mail.length = 0;
r = await stripeClaim(post('/api/stripe/claim', { session_id: s.id, password: 'a-long-password-8' }), env);
d = await r.json();
ok('a paying buyer still gets the claim code', r.status === 200 && d.email_sent === true && mail.length === 1 && /\b\d{6}\b/.test(mail[0].subject + mail[0].text), { d, n: mail.length });
ok('claim codes are counted on their own', db.prepare("SELECT n FROM daily_counts WHERE k = 'mail:claim' AND day = ?").get(day)?.n === claimsBefore + 1 && db.prepare("SELECT n FROM daily_counts WHERE k = 'mail:verify' AND day = ?").get(day)?.n === 151);
db.prepare("DELETE FROM rate_limits WHERE key LIKE 'resend-code:%'").run();
mail.length = 0;
r = await auth.resendCode(post('/api/auth/resend-code', { email: 'capbuyer@example.com' }), env);
ok('their Resend code works at the sign-up cap too', r.status === 200 && mail.length === 1, mail.length);

// 12. The old emailed-link route is gone (it had no guess limit).
ok('no legacy verify-link handler', typeof auth.verifyEmailRoute === 'undefined');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
