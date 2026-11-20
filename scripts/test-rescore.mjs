// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// node scripts/test-rescore.mjs  --  server check for round 2 (2026-09-27): the free first re-check,
// the paid second one, refunds on failure, score + month average in the list, and status timestamps.
// Real migrations on an in-memory node:sqlite database behind a tiny D1 shim. The Anthropic call is
// stubbed, nothing leaves this machine.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  bind: (...a) => stmt(sql, a),
  first: async () => db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
});
const DB = { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map(s => s.run())) };

let claudeReply = { match_score: 8, match_notes: 'ok', key_alignments: [], potential_gaps: [] }, claudeFail = false, claudeCalls = 0;
globalThis.fetch = async (url) => {
  if (String(url).includes('anthropic')) {
    claudeCalls++;
    if (claudeFail) return new Response('boom', { status: 500 });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(claudeReply) }], stop_reason: 'end_turn', model: 'stub' }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};
const env = { DB, JWT_SECRET: 'test-secret-test-secret-test-secret-1234', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_PRO: 'price_pro', ANTHROPIC_API_KEY: 'stub' };
const { makeJWT } = await import(join(R, 'src/auth.js'));
const T = await import(join(R, 'src/routes/tweak-routes.js'));

const now = Math.floor(Date.now() / 1000);
db.prepare(`INSERT INTO users (id, email, pw_hash, plan, email_verified, token_version, created_at, updated_at, stripe_subscription_id)
            VALUES ('u1','a@b.c','x','pro',1,0,?,?, 'sub_1')`).run(now, now);
db.prepare(`INSERT INTO users (id, email, pw_hash, plan, email_verified, token_version, created_at, updated_at) VALUES ('other','o@b.c','x','pro',1,0,?,?)`).run(now, now);
db.prepare(`INSERT INTO resumes (uid, parsed_json, raw_text, uploaded_at, updated_at) VALUES ('u1','{}','resume text',?,?)`).run(now, now);
const good = JSON.stringify({ match_score: 6 });
db.prepare(`INSERT INTO tweaks (id, uid, jd, role_title, analysis_json, created_at) VALUES ('t1','u1','jd','Writer',?,?)`).run(good, now);
db.prepare(`INSERT INTO tweaks (id, uid, jd, role_title, analysis_json, created_at) VALUES ('t2','u1','jd','Editor','{"score": 4}',?)`).run(now - 60);
db.prepare(`INSERT INTO tweaks (id, uid, jd, role_title, analysis_json, created_at) VALUES ('t3','u1','jd','Broken','not json',?)`).run(now - 120);
db.prepare(`INSERT INTO tweaks (id, uid, jd, role_title, analysis_json, created_at) VALUES ('t9','other','jd','Theirs',?,?)`).run(good, now);

const tok = await makeJWT({ sub: 'u1', tv: 0, iat: now, exp: now + 3600 }, env.JWT_SECRET);
const req = (method, path, body) => new Request('https://resumeprune.com' + path, {
  method, headers: { Cookie: 'rp_session=' + tok, Origin: 'https://resumeprune.com', 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
  body: body ? JSON.stringify(body) : undefined,
});
const call = async (fn, ...a) => { try { const r = await fn(...a); return [r.status, await r.json()]; } catch (e) { if (e instanceof Response) return [e.status, await e.json()]; throw e; } };
const used = () => db.prepare(`SELECT COALESCE(SUM(tweaks_used),0) n FROM usage_counters WHERE uid='u1'`).get().n;
const rescores = (id) => db.prepare(`SELECT rescores FROM tweaks WHERE id=?`).get(id).rescores;
const out = []; const ok = (n, c, x = '') => out.push(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  (' + x + ')' : ''}`);

let [st, d] = await call(T.tweakList, req('GET', '/api/tweaks?limit=30'), env);
const by = Object.fromEntries(d.tweaks.map(t => [t.id, t]));
ok('list: score from match_score', by.t1.score === 6, JSON.stringify(by.t1.score));
ok('list: score from old "score" key', by.t2.score === 4);
ok('list: malformed analysis_json does not break the list', st === 200 && by.t3.score === null);
ok('list: month average', d.month_avg === 5 && d.month_scored === 2, `${d.month_avg}/${d.month_scored}`);
ok('list: other users excluded', !by.t9);
ok('list: rows made after the migration start with no status time (PATCH stamps it)', by.t1.status_updated_at === null);

claudeFail = true;
[st, d] = await call(T.tweakRescore, req('POST', '/api/tweaks/t1/rescore', {}), env, 't1');
ok('rescore fail: 502', st === 502);
ok('rescore fail: free re-check refunded', rescores('t1') === 0 && used() === 0);
claudeFail = false;

[st, d] = await call(T.tweakRescore, req('POST', '/api/tweaks/t1/rescore', {}), env, 't1');
ok('rescore 1: free', st === 200 && d.free === true && used() === 0, `${st} ${JSON.stringify(d).slice(0, 80)}`);
ok('rescore 1: analysis saved', JSON.parse(db.prepare(`SELECT analysis_json a FROM tweaks WHERE id='t1'`).get().a).match_score === 8);
[st, d] = await call(T.tweakDetail, req('GET', '/api/tweaks/t1'), env, 't1');
ok('detail: rescores = 1', d.tweak.rescores === 1);

[st, d] = await call(T.tweakRescore, req('POST', '/api/tweaks/t1/rescore', {}), env, 't1');
ok('rescore 2: costs a tweak', st === 200 && d.free === false && used() === 1 && rescores('t1') === 2, `used=${used()}`);

claudeFail = true;
[st, d] = await call(T.tweakRescore, req('POST', '/api/tweaks/t1/rescore', {}), env, 't1');
ok('rescore 3 fail: paid slot refunded', st === 502 && used() === 1, `used=${used()}`);
claudeFail = false;

db.exec('DELETE FROM rate_limits'); // 5-a-minute burst cap, tested below
db.prepare(`UPDATE usage_counters SET tweaks_used = 40 WHERE uid='u1'`).run();
[st, d] = await call(T.tweakRescore, req('POST', '/api/tweaks/t1/rescore', {}), env, 't1');
ok('rescore at limit: LIMIT_REACHED, no AI call', st === 429 && d.code === 'LIMIT_REACHED');
[st, d] = await call(T.tweakRescore, req('POST', '/api/tweaks/t2/rescore', {}), env, 't2');
ok('rescore at limit: another job still gets its free one', st === 200 && d.free === true, st + ' ' + (d.error || ''));
db.exec('DELETE FROM rate_limits');

[st, d] = await call(T.tweakRescore, req('POST', '/api/tweaks/t9/rescore', {}), env, 't9');
ok("rescore: someone else's tweak is 404", st === 404, String(st));
for (let i = 0; i < 6; i++) [st, d] = await call(T.tweakRescore, req('POST', '/api/tweaks/t2/rescore', {}), env, 't2');
ok('rescore: burst cap kicks in', st === 429, String(st));
const bad = new Request('https://resumeprune.com/api/tweaks/t1/rescore', { method: 'POST', headers: { Cookie: 'rp_session=' + tok, Origin: 'https://evil.example' } });
[st, d] = await call(T.tweakRescore, bad, env, 't1');
ok('rescore: cross-origin blocked', st === 403);

// no free re-check without an active plan, and a daily ceiling.
db.exec('DELETE FROM rate_limits');
db.prepare(`UPDATE users SET plan='free', stripe_subscription_id=NULL WHERE id='u1'`).run();
db.prepare(`UPDATE tweaks SET rescores = 0 WHERE id='t3'`).run();
let calls0 = claudeCalls;
[st, d] = await call(T.tweakRescore, req('POST', '/api/tweaks/t3/rescore', {}), env, 't3');
ok('rescore: lapsed plan gets NO_PLAN, no AI call, free claim untouched', st === 402 && d.code === 'NO_PLAN' && claudeCalls === calls0 && rescores('t3') === 0, `${st}`);
db.prepare(`UPDATE users SET plan='pro', stripe_subscription_id='sub_1' WHERE id='u1'`).run();
db.exec('DELETE FROM rate_limits');
db.prepare(`INSERT INTO rate_limits (key, ts) SELECT 'uid:u1:tweak-rescore-day', ? FROM (WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<30) SELECT i FROM n)`).run(now);
calls0 = claudeCalls;
[st, d] = await call(T.tweakRescore, req('POST', '/api/tweaks/t3/rescore', {}), env, 't3');
ok('rescore: daily cap of 30 blocks the 31st, no AI call', st === 429 && claudeCalls === calls0, String(st));
db.exec('DELETE FROM rate_limits');

db.prepare(`UPDATE tweaks SET status_updated_at = 1 WHERE id='t1'`).run();
[st, d] = await call(T.tweakSetStatus, req('PATCH', '/api/tweaks/t1', { app_status: 'applied' }), env, 't1');
ok('status: PATCH stamps status_updated_at', st === 200 && Math.abs(d.status_updated_at - now) < 5 && db.prepare(`SELECT status_updated_at s FROM tweaks WHERE id='t1'`).get().s === d.status_updated_at);
console.log(out.join('\n'));
if (out.some(l => l.startsWith('FAIL'))) process.exit(1);

// The normal check still spends exactly one tweak after the claimTweakSlot refactor.
db.exec('DELETE FROM rate_limits'); db.prepare(`UPDATE usage_counters SET tweaks_used = 0 WHERE uid='u1'`).run();
[st, d] = await call(T.tweakAnalyze, req('POST', '/api/tweak/analyze', { jobDescription: 'j'.repeat(80), roleTitle: 'QA' }), env);
ok('analyze: still works and spends one tweak', st === 200 && used() === 1 && d.tweaksRemaining === 39, `${st} used=${used()}`);
claudeFail = true;
[st, d] = await call(T.tweakAnalyze, req('POST', '/api/tweak/analyze', { jobDescription: 'j'.repeat(80), roleTitle: 'QA' }), env);
ok('analyze: failure refunds the tweak', st === 502 && used() === 1);
claudeFail = false;

// Migration 0017 on rows that existed before it: every row gets a status time.
const db2 = new DatabaseSync(':memory:');
const migs = readdirSync(join(R, 'migrations')).sort();
for (const f of migs.filter(f => f < '0017')) db2.exec(readFileSync(join(R, 'migrations', f), 'utf8'));
db2.exec(`INSERT INTO users (id, email, pw_hash, plan, email_verified, token_version, created_at, updated_at) VALUES ('u','e','x','pro',1,0,1,1);
          INSERT INTO tweaks (id, uid, jd, created_at, app_status) VALUES ('a','u','jd',1,'applied');`);
for (const f of migs.filter(f => f >= '0017')) db2.exec(readFileSync(join(R, 'migrations', f), 'utf8'));
const row = db2.prepare(`SELECT rescores, status_updated_at s FROM tweaks WHERE id='a'`).get();
ok('migration: old rows get rescores 0 + a status time of now', row.rescores === 0 && Math.abs(row.s - now) < 60, JSON.stringify(row));
console.log(out.slice(-3).join('\n'));
if (out.some(l => l.startsWith('FAIL'))) process.exit(1);
