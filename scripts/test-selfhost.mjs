// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// node scripts/test-selfhost.mjs  --  a copy with paid plans OFF needs no plan: a new account
// can run the whole thing with no tweak limit and is never told to pick a plan. A copy with
// paid plans ON keeps the plan rules. In-memory node:sqlite, AI stubbed, nothing leaves this machine.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const realError = console.error;
console.error = (...a) => { if (/^FAIL/.test(String(a[0]))) realError(...a); };

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
let aiCalls = 0;
const AI = JSON.stringify({ name: 'Sam Rivera', experience: [], skills: [], match_score: 7, key_alignments: [], potential_gaps: [], paragraphs: ['a', 'b', 'c'] });
globalThis.fetch = async (url) => String(url).includes('anthropic')
  ? (aiCalls++, new Response(JSON.stringify({ content: [{ type: 'text', text: AI }], stop_reason: 'end_turn' }), { status: 200 }))
  : new Response('{}', { status: 200 });

const BASE = 'https://copy.example.com';
const open = { DB, JWT_SECRET: 'test-secret-test-secret-test-secret-1234', ANTHROPIC_API_KEY: 'stub', APP_URL: BASE };
const selling = { ...open, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_PRO: 'price_pro' };
const { makeJWT } = await import(join(R, 'src/auth.js'));
const { effectivePlan, billingOn, planLimit } = await import(join(R, 'src/lib/usage.js'));
const T = await import(join(R, 'src/routes/tweak-routes.js'));
const P = await import(join(R, 'src/routes/profile-routes.js'));
const G = await import(join(R, 'src/routes/gapfill-routes.js'));
const Pages = await import(join(R, 'src/routes/pages-routes.js'));
const Stripe = await import(join(R, 'src/routes/stripe-routes.js'));

let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log('PASS ', label); } else { fail++; console.error('FAIL ', label, extra === undefined ? '' : JSON.stringify(extra)); } };
const now = Math.floor(Date.now() / 1000);
db.prepare("INSERT INTO users (id, email, pw_hash, plan, email_verified, token_version, created_at, updated_at) VALUES ('u1','new@example.com','x','free',1,0,?,?)").run(now, now);
const cookie = 'rp_session=' + await makeJWT({ sub: 'u1', tv: 0, iat: now, exp: now + 3600 }, open.JWT_SECRET);
const req = (method, path, body) => new Request(BASE + path, { method,
  headers: { Cookie: cookie, Origin: BASE, 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.1.1.1' }, body: body ? JSON.stringify(body) : undefined });
const call = async (fn, ...a) => { try { const r = await fn(...a); return [r.status, await r.json()]; } catch (e) { if (e instanceof Response) return [e.status, await e.json()]; throw e; } };
const RESUME = 'Sam Rivera. Practice manager with a long background in clinic management. '.repeat(3);
const JD = 'We need a practice manager who can run a busy front desk and keep the schedule on track.';
const said = [];
const noPitch = d => { said.push(JSON.stringify(d)); return !/pick a (paid )?plan|paid plans|NO_PLAN|Sprint|\bPro\b/i.test(JSON.stringify(d)); };

ok('billingOn: off with no Stripe settings, on with a key and a price', billingOn(open) === false && billingOn(selling) === true);
ok("plan is 'open' when paid plans are off", effectivePlan({ plan: 'free' }, open) === 'open' && planLimit('open') >= 1000000);
ok('plan rules unchanged when paid plans are on', effectivePlan({ plan: 'free' }, selling) === 'free' && effectivePlan({ plan: 'pro', stripe_subscription_id: 's' }, selling) === 'pro');
ok('no env passed (older callers): unchanged', effectivePlan({ plan: 'free' }) === 'free');

// A brand-new account on a copy with paid plans off.
let [st, d] = await call(P.getProStatus, req('GET', '/api/pro-status'), open);
ok('status says open, with tweaks to spend', st === 200 && d.open === true && d.plan === 'open' && d.tweaks_remaining > 1000, d);
[st, d] = await call(P.uploadResume, req('POST', '/api/profile/upload-resume', { rawText: RESUME }), open);
ok('resume upload works', st === 200 && !!d.parsed, [st, d]);
[st, d] = await call(P.saveResume, req('PUT', '/api/profile/resume', { rawText: RESUME, parsedJson: { name: 'Sam Rivera', experience: [] } }), open);
ok('resume saves', st === 200, [st, d]);
[st, d] = await call(T.tweakAnalyze, req('POST', '/api/tweak/analyze', { jobDescription: JD }), open);
ok('match check works with no plan (no 402)', st === 200 && !!d.tweakId && noPitch(d), [st, d]);
const tweakId = d.tweakId;
[st, d] = await call(T.tweakGenerate, req('POST', '/api/tweak/generate', { tweakId, mode: 'resume' }), open);
ok('pruned resume works', st === 200 && !!d.resume, [st, d]);
[st, d] = await call(T.tweakGenerate, req('POST', '/api/tweak/generate', { tweakId, mode: 'cover' }), open);
ok('cover letter works', st === 200 && !!d.cover, [st, d]);
[st, d] = await call(G.gapFillCreate, req('POST', '/api/gap-fills', { gap: 'Budget ownership', job: 'Practice Manager at Maple Grove', body: 'Owned the clinic supply budget for two years.' }), open);
ok('saving experience works', st === 201, [st, d]);
[st, d] = await call(T.tweakRescore, req('POST', `/api/tweaks/${tweakId}/rescore`), open, tweakId);
ok('re-check works', st === 200, [st, d]);
[st, d] = await call(Pages.resumePageCreate, req('POST', '/api/resume-pages', { tweak_id: tweakId, slug: 'sam-rivera' }), open);
ok('publishing a resume link works', st === 201, [st, d]);
// No tweak limit: well past the 40 a paid plan would allow.
db.prepare("UPDATE usage_counters SET tweaks_used = 500 WHERE uid = 'u1'").run();
db.prepare("DELETE FROM rate_limits").run();
[st, d] = await call(T.tweakAnalyze, req('POST', '/api/tweak/analyze', { jobDescription: JD }), open);
ok('still works after 500 tweaks this month', st === 200 && noPitch(d), [st, d]);

// Billing endpoints on this copy: a plain "not set up", never a checkout.
[st, d] = await call(Stripe.stripeCreateCheckout, req('POST', '/api/stripe/create-checkout', { plan: 'pro' }), open);
ok('checkout: 404 not set up', st === 404 && /aren't set up on this copy/.test(d.error), [st, d]);
[st, d] = await call(Stripe.stripeCreatePortal, req('POST', '/api/stripe/create-portal'), open);
ok('billing portal: 404 not set up', st === 404, [st, d]);

// No AI key on this copy: the clear message, and still no plan talk.
[st, d] = await call(T.tweakAnalyze, req('POST', '/api/tweak/analyze', { jobDescription: JD }), { ...open, ANTHROPIC_API_KEY: '' });
ok("no AI key: says AI isn't set up, not a 402", st === 503 && d.code === 'AI_NOT_SET_UP' && noPitch(d), [st, d]);

// The same new account on a copy that DOES sell plans still needs one.
db.prepare("DELETE FROM rate_limits").run();
[st, d] = await call(T.tweakAnalyze, req('POST', '/api/tweak/analyze', { jobDescription: JD }), selling);
ok('paid plans on: a free account still gets 402', st === 402 && d.code === 'NO_PLAN', [st, d]);
[st, d] = await call(P.getProStatus, req('GET', '/api/pro-status'), selling);
ok('paid plans on: status is free, not open', d.plan === 'free' && d.open === false && d.tweaks_limit === 0, d);

// The pages: the open state is handled, and "Pick a plan" only sits behind the paid-plans check.
const appJs = readFileSync(join(R, 'public/app.js'), 'utf8'), account = readFileSync(join(R, 'public/account.html'), 'utf8');
ok('dashboard handles the open state before any plan text', appJs.indexOf('if (s.open)') > 0 && appJs.indexOf('if (s.open)') < appJs.indexOf('Pick a plan'));
ok('account page handles the open state', /if \(s\.open\)/.test(account) && /else if \(s\.open\)/.test(account));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
