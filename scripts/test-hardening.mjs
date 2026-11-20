// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// node scripts/test-hardening.mjs  --  abuse and failure paths: AI cost ceilings, the free-sample
// slot, error messages that don't leak, a bad link path, response headers, reset timing.
// Real migrations on an in-memory node:sqlite database. AI and email are stubbed, nothing leaves this machine.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const R = join(dirname(fileURLToPath(import.meta.url)), '..');

// The app logs its own errors while these tests force failures on purpose. They are
// collected here (some checks read them) and stay out of the output.
const logged = [];
const realError = console.error, realLog = console.log;
console.error = (...a) => { if (/^(FAIL|\s*✗)/.test(String(a[0]))) realError(...a); else logged.push(a.map(String).join(' ')); };
console.log = (...a) => { if (/^(PASS|\n?\d+ passed)/.test(String(a[0]))) realLog(...a); else logged.push(a.map(String).join(' ')); };

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

let aiCalls = 0, aiFail = false, aiDelay = 0;
const mail = [];
const AI_TEXT = JSON.stringify({ name: 'Sam Rivera', contact: { email: 'x@example.com' }, experience: [], skills: [], education: [],
  match_score: 7, match_notes: 'ok', key_alignments: [], potential_gaps: [], greeting: 'Hello,', paragraphs: ['a', 'b', 'c'], signoff: 'Thanks,' });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('anthropic')) {
    aiCalls++;
    if (aiDelay) await new Promise(r => setTimeout(r, aiDelay));
    if (aiFail) return new Response('{"error":{"message":"secret upstream detail req_abc123"}}', { status: 400 });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: AI_TEXT }], stop_reason: 'end_turn' }), { status: 200 });
  }
  if (u.includes('api.resend.com')) { mail.push(JSON.parse(init.body)); return new Response('{"id":"m"}', { status: 200 }); }
  return new Response('{}', { status: 200 });
};

const BASE = 'https://resumeprune.com';
const env = { DB, JWT_SECRET: 'test-secret-test-secret-test-secret-1234', ANTHROPIC_API_KEY: 'stub', RESEND_API_KEY: 'x', APP_URL: BASE,
  ALLOW_NO_TURNSTILE: 'true', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_PRO: 'price_pro', GLOBAL_SAMPLE_CAP: '1000' };
const worker = (await import(join(R, 'src/worker.js'))).default;
const { makeJWT } = await import(join(R, 'src/auth.js'));
const P = await import(join(R, 'src/routes/profile-routes.js'));
const S = await import(join(R, 'src/routes/sample-routes.js'));
const A = await import(join(R, 'src/routes/auth-routes.js'));

let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log('PASS ', label); } else { fail++; console.error('FAIL ', label, extra === undefined ? '' : JSON.stringify(extra)); } };
const now = Math.floor(Date.now() / 1000);
const call = async (fn, ...a) => { try { const r = await fn(...a); return [r.status, await r.json().catch(() => ({})), r]; } catch (e) { if (e instanceof Response) return [e.status, await e.json().catch(() => ({})), e]; throw e; } };
const ctx = () => { const jobs = []; return { jobs, waitUntil: p => jobs.push(p) }; };
const post = (path, body, headers = {}) => new Request(BASE + path, { method: 'POST',
  headers: { Origin: BASE, 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.9.0.1', ...headers }, body: JSON.stringify(body) });
const addUser = async (id, plan = 'free', sub = null) => {
  db.prepare(`INSERT INTO users (id, email, pw_hash, plan, email_verified, token_version, stripe_subscription_id, created_at, updated_at)
              VALUES (?, ?, 'x', ?, 1, 0, ?, ?, ?)`).run(id, `${id}@example.com`, plan, sub, now, now);
  return 'rp_session=' + await makeJWT({ sub: id, tv: 0, iat: now, exp: now + 3600 }, env.JWT_SECRET);
};
const RESUME = 'Sam Rivera. Practice manager with a long background in clinic management. '.repeat(3);
const JD = 'We need a practice manager who can run a busy front desk and keep the schedule on track.';

// 1. A link path that isn't valid percent-encoding is a 404 page, not a crash.
let r = await worker.fetch(new Request(BASE + '/r/%'), env, ctx());
ok('bad /r/ path: 404, not 500', r.status === 404, r.status);
ok('bad /r/ path: the "not live" page', /isn't live/.test(await r.text()));
r = await worker.fetch(new Request(BASE + '/r/%E0%A4%A'), env, ctx());
ok('half a UTF-8 sequence: 404 too', r.status === 404, r.status);

// 2. API answers: never cached, never sniffed, HSTS over https only.
r = await worker.fetch(new Request(BASE + '/api/health'), env, ctx());
ok('API answer is no-store', r.headers.get('Cache-Control') === 'no-store', r.headers.get('Cache-Control'));
ok('API answer is nosniff', r.headers.get('X-Content-Type-Options') === 'nosniff');
ok('HSTS on https', /max-age=\d{7,}/.test(r.headers.get('Strict-Transport-Security') || ''), r.headers.get('Strict-Transport-Security'));
r = await worker.fetch(new Request('http://localhost:8787/api/health'), env, ctx());
ok('no HSTS on plain http (local dev)', !r.headers.get('Strict-Transport-Security'));

// 3. The old emailed-link verify route is gone.
r = await worker.fetch(new Request(BASE + '/api/auth/verify-email?token=someone:123456'), env, ctx());
ok('legacy verify-link route: 404', r.status === 404, r.status);

// 4. Accounts with no plan share one daily ceiling on AI resume reads. Accounts on a plan don't count.
const capEnv = { ...env, FREE_PARSE_DAILY_CAP: '2' };
const cookies = [];
for (let i = 0; i < 6; i++) cookies.push(await addUser(`free${i}`));
aiCalls = 0;
const burst = await Promise.all(cookies.map(c => call(P.uploadResume, post('/api/profile/upload-resume', { rawText: RESUME }, { Cookie: c }), capEnv)));
const got = burst.filter(([st]) => st === 200).length, capped = burst.filter(([st, d]) => st === 429 && d.reason === 'free-parse-cap').length;
ok('6 no-plan accounts at once, ceiling 2: exactly 2 get through', got === 2 && capped === 4, burst.map(b => b[0]));
ok('only 2 AI calls were made', aiCalls === 2, aiCalls);
const paid = await addUser('payer', 'pro', 'sub_payer');
aiCalls = 0;
let [st, d] = await call(P.uploadResume, post('/api/profile/upload-resume', { rawText: RESUME }, { Cookie: paid }), capEnv);
ok('an account on a plan is not held back by that ceiling', st === 200 && aiCalls === 1, st);
[st, d] = await call(P.uploadResume, post('/api/profile/upload-resume', { rawText: 'too short' }, { Cookie: cookies[5] }), { ...env, FREE_PARSE_DAILY_CAP: '3' });
ok('text that fails the checks never spends the ceiling', st === 400 && db.prepare("SELECT n FROM daily_counts WHERE k = 'ai:free-parse'").get().n === 6);
ok('default ceiling is 200 when the setting is blank', /FREE_PARSE_DAILY_DEFAULT = 200/.test(readFileSync(join(R, 'src/routes/profile-routes.js'), 'utf8')));

// 5. A failed AI call: fixed message to the visitor, the upstream detail only in the log.
aiFail = true; logged.length = 0;
[st, d] = await call(S.sampleAnalyze, post('/api/sample/analyze', { resumeText: RESUME, jobDescription: JD }), env);
ok('sample analyze failure: 502 with a fixed message', st === 502 && /didn't finish/.test(d.error), d);
ok('no upstream detail in the answer', !('detail' in d) && !/Anthropic|req_abc123|secret upstream/.test(JSON.stringify(d)), d);
ok('the detail is in the log', logged.some(l => /req_abc123/.test(l)));
[st, d] = await call(S.sampleGenerate, post('/api/sample/generate', { email: 'leak@example.com', resumeText: RESUME, jobDescription: JD }), env);
ok('sample generate failure: 502, fixed message, no detail', st === 502 && !('detail' in d) && !/Anthropic|req_abc123/.test(JSON.stringify(d)), d);
ok('a failed sample gives the slot back', db.prepare('SELECT COUNT(*) c FROM free_samples').get().c === 0);
aiFail = false;

// 6. No AI key: a clear message, before any ceiling or slot is spent.
const noKey = { ...env, ANTHROPIC_API_KEY: '' };
const capBefore = db.prepare("SELECT COALESCE(SUM(n),0) n FROM daily_counts WHERE k = 'global:sample-claude'").get().n;
[st, d] = await call(S.sampleAnalyze, post('/api/sample/analyze', { resumeText: RESUME, jobDescription: JD }, { 'CF-Connecting-IP': '10.9.0.2' }), noKey);
ok('no AI key, free plan page: says AI is not set up', st === 503 && d.code === 'AI_NOT_SET_UP' && /AI isn't set up/.test(d.error), d);
[st, d] = await call(S.sampleGenerate, post('/api/sample/generate', { email: 'nokey@example.com', resumeText: RESUME, jobDescription: JD }), noKey);
ok('no AI key, generate: same message', st === 503 && d.code === 'AI_NOT_SET_UP', d);
ok('no AI key: daily ceiling untouched, no sample row', db.prepare("SELECT COALESCE(SUM(n),0) n FROM daily_counts WHERE k = 'global:sample-claude'").get().n === capBefore && db.prepare('SELECT COUNT(*) c FROM free_samples').get().c === 0);
[st, d] = await call(P.uploadResume, post('/api/profile/upload-resume', { rawText: RESUME }, { Cookie: paid }), noKey);
ok('no AI key, resume upload: same message, not "try a cleaner copy"', st === 503 && d.code === 'AI_NOT_SET_UP', d);

// 7. The free-sample limit holds under a burst: 2 a month per address, even in parallel.
aiCalls = 0; aiDelay = 15;
const gen = (email, ipAddr) => call(S.sampleGenerate, post('/api/sample/generate', { email, resumeText: RESUME, jobDescription: JD, parsedResume: { name: 'Sam' } }, { 'CF-Connecting-IP': ipAddr }), env);
const many = await Promise.all([1, 2, 3, 4, 5, 6].map(i => gen('burst@example.com', `10.8.0.${i}`)));
aiDelay = 0;
ok('6 parallel samples for one address: exactly 2 made', many.filter(m => m[0] === 200).length === 2 && many.filter(m => m[0] === 429).length === 4, many.map(m => m[0]));
ok('only those 2 reached the AI (2 calls each)', aiCalls === 4, aiCalls);
ok('2 stored rows, each with its result', db.prepare("SELECT COUNT(*) c FROM free_samples WHERE result_json IS NOT NULL").get().c === 2 && db.prepare("SELECT COUNT(*) c FROM free_samples").get().c === 2);
const one = many.find(m => m[0] === 200)[1];
r = await S.sampleResult(new Request(BASE + '/api/sample/result/' + one.sampleId), env, one.sampleId);
ok('the stored sample opens from its link', r.status === 200 && !!(await r.json()).resume);
// A reservation whose request died stops counting after 10 minutes.
const { freeSampleHash } = await import(join(R, 'src/helpers.js'));
const crashHash = await freeSampleHash(env, 'email', 'crash@example.com');
for (const id of ['dead1', 'dead2']) {
  db.prepare("INSERT INTO free_samples (id, email_hash, email_domain, ip_hash, used_at, newsletter_consent, result_json) VALUES (?, ?, 'dead.example', 'deadip', ?, 0, NULL)").run(id, crashHash, now - 700);
}
[st, d] = await gen('crash@example.com', '10.7.0.1');
ok('two dead reservations do not use up an address', st === 200, [st, d]);

// 8. Match checks on the free plan page: 5 an hour per network.
let codes = [];
for (let i = 0; i < 6; i++) codes.push((await call(S.sampleAnalyze, post('/api/sample/analyze', { resumeText: RESUME, jobDescription: JD }, { 'CF-Connecting-IP': '10.6.0.1' }), env))[0]);
ok('5 match checks pass, the 6th in an hour is refused', codes.slice(0, 5).every(c => c === 200) && codes[5] === 429, codes);

// 9. A reset request answers before any mail work, the same for every address.
await addUser('resetme');
mail.length = 0;
let c = ctx();
r = await A.resetRequest(post('/api/auth/reset-request', { email: 'resetme@example.com' }, { 'CF-Connecting-IP': '10.5.0.1' }), env, c);
ok('reset answers 200 with the work handed to the background', r.status === 200 && c.jobs.length === 1 && mail.length === 0, { jobs: c.jobs.length, mail: mail.length });
await Promise.all(c.jobs);
ok('the reset mail still goes out', mail.length === 1 && /reset/i.test(mail[0].subject), mail.map(m => m.subject));
c = ctx(); mail.length = 0;
r = await A.resetRequest(post('/api/auth/reset-request', { email: 'nobody-here@example.com' }, { 'CF-Connecting-IP': '10.5.0.2' }), env, c);
await Promise.all(c.jobs);
ok('unknown address: same answer, same hand-off, no mail', r.status === 200 && c.jobs.length === 1 && mail.length === 0);

// 10. With no email key, the sign-up code never lands in the log.
logged.length = 0;
[st, d] = await call(A.signup, post('/api/auth/signup', { email: 'quiet@example.com', password: 'a-long-password-1' }, { 'CF-Connecting-IP': '10.4.0.1' }), { ...env, RESEND_API_KEY: '', APP_URL: BASE, DEV_LOG_CODES: '' });
ok('sign-up with no email key says the code was not sent', st === 200 && d.email_sent === false, d);
ok('no 6-digit code in the log', !logged.some(l => /\b\d{6}\b/.test(l)), logged.filter(l => /\b\d{6}\b/.test(l)));

realLog(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
