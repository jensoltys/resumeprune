// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// node scripts/test-unsubscribe.mjs  --  mail-app one-click unsubscribe, free-sample results mail,
// share-tag URLs and the free_samples hash salt (fixes from the 2026-11-20 open-source review).
// Real migrations on an in-memory node:sqlite database. Email is stubbed, nothing leaves this machine.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const R = join(dirname(fileURLToPath(import.meta.url)), '..');

const db = new DatabaseSync(':memory:');
for (const f of readdirSync(join(R, 'migrations')).sort()) db.exec(readFileSync(join(R, 'migrations', f), 'utf8'));
const stmt = (sql, args = []) => ({
  sql,
  bind: (...a) => stmt(sql, a),
  first: async () => db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
});
const DB = { prepare: sql => stmt(sql), batch: async list => Promise.all(list.map(s => s.run())) };

const mail = [];
globalThis.fetch = async (url, init = {}) => {
  if (new URL(String(url)).hostname === 'api.resend.com') { mail.push(JSON.parse(init.body)); return new Response('{"id":"m"}', { status: 200 }); }
  return new Response('{}', { status: 200 });
};

const PAGE = `<!doctype html><html><head>
<meta property="og:url" content="/">
<meta property="og:image" content="/og.png?v=3">
<meta name="twitter:image" content="/og.png?v=3">
<meta property="og:image:alt" content="/not-a-url-tag">
<link rel="icon" href="/favicon.ico">
</head><body><script>1</script></body></html>`;
const ASSETS = { fetch: async () => new Response(PAGE, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }) };
const env = { DB, ASSETS, JWT_SECRET: 'test-secret-test-secret-test-secret-1234', RESEND_API_KEY: 'x', APP_URL: 'https://rp.example.com', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_PRO: 'price_pro' };
const ctx = { waitUntil() {} };

const worker = (await import(join(R, 'src/worker.js'))).default;
const { fillShareUrls } = await import(join(R, 'src/worker.js'));
const { makeUnsubscribeUrl } = await import(join(R, 'src/lib/unsubscribe.js'));
const { sendSampleEmail } = await import(join(R, 'src/routes/sample-routes.js'));
const { freeSampleHash, sha256Hex } = await import(join(R, 'src/helpers.js'));

let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log('PASS ', label); } else { fail++; console.error('FAIL ', label, extra ?? ''); } };
const optedOut = async email => !!db.prepare('SELECT 1 FROM email_optouts WHERE email_hash = ?').get(await sha256Hex(email));

// 1. The mail app's one-click button POSTs to exactly the URL in the List-Unsubscribe header.
const url = await makeUnsubscribeUrl(env, 'oneclick@example.com');
let r = await worker.fetch(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' }), env, ctx);
ok('one-click POST to the header URL returns 200', r.status === 200, r.status);
ok('one-click POST records the opt-out', await optedOut('oneclick@example.com'));
r = await worker.fetch(new Request(url.replace(/u=[^&]+/, 'u=bad.token'), { method: 'POST', body: 'List-Unsubscribe=One-Click' }), env, ctx);
ok('one-click POST with a bad token is refused, not a 5xx', r.status === 400, r.status);

// 2. The link in the email body (GET) still works, and promises no control that doesn't exist.
const url2 = await makeUnsubscribeUrl(env, 'link@example.com');
r = await worker.fetch(new Request(url2), env, ctx);
const page = await r.text();
ok('GET unsubscribe link returns the page', r.status === 200 && /unsubscribed/i.test(page), r.status);
ok('GET unsubscribe records the opt-out', await optedOut('link@example.com'));
ok('unsubscribe page mentions no toggle', !/toggle/i.test(page));

// 3. Free-sample mail: anyone can type any address, so an address that unsubscribed gets nothing.
const sample = { resumeJson: { name: 'Sam', sections: [] }, coverJson: { paragraphs: ['Hi'] }, viewerUrl: 'https://rp.example.com/sample.html?id=1', signupUrl: 'https://rp.example.com/signup?from=sample' };
mail.length = 0;
await sendSampleEmail(env, { email: 'fresh@example.com', ...sample });
ok('sample mail sent to a subscribed address', mail.length === 1);
ok('sample mail is not sent as a marketing mail', !mail[0]?.headers);
ok('sample mail keeps the plans pitch and its unsubscribe link', /Sprint is/.test(mail[0]?.html) && /\/unsubscribe\?u=/.test(mail[0]?.html));
mail.length = 0;
const skipped = await sendSampleEmail(env, { email: 'oneclick@example.com', ...sample });
ok('no sample mail to an address that unsubscribed', mail.length === 0 && skipped?.reason === 'opted-out');

mail.length = 0;
await sendSampleEmail({ ...env, STRIPE_SECRET_KEY: '' }, { email: 'nobilling@example.com', ...sample });
ok('no billing on this copy: sample mail has no plans pitch', mail.length === 1 && !/Sprint is|See plans/.test(mail[0].html));

// 4. Share tags get this site's address at serve time.
r = await worker.fetch(new Request('https://rp.example.com/'), env, ctx);
const home = await r.text();
ok('og:url made absolute', home.includes('<meta property="og:url" content="https://rp.example.com/">'));
ok('og:image made absolute', home.includes('<meta property="og:image" content="https://rp.example.com/og.png?v=3">'));
ok('twitter:image made absolute', home.includes('<meta name="twitter:image" content="https://rp.example.com/og.png?v=3">'));
ok('other tags untouched', home.includes('content="/not-a-url-tag"') && home.includes('href="/favicon.ico"'));
ok('script nonce still added', /<script nonce="/.test(home));
ok('absolute tags are left alone', fillShareUrls('<meta property="og:image" content="https://resumeprune.com/og.png">', env) === '<meta property="og:image" content="https://resumeprune.com/og.png">');
ok('no APP_URL leaves the page as is', fillShareUrls(PAGE, {}) === PAGE);

// 5. free_samples hashes are salted with the server secret.
const plain = createHash('sha256').update('203.0.113.9').digest('hex');
const salted = await freeSampleHash(env, 'ip', '203.0.113.9');
ok('ip hash is not a plain sha256', salted !== plain && /^[a-f0-9]{64}$/.test(salted));
ok('ip hash changes with the secret', salted !== await freeSampleHash({ JWT_SECRET: 'another-secret-another-secret-12345' }, 'ip', '203.0.113.9'));
ok('email hash ignores case and spaces', await freeSampleHash(env, 'email', ' Sam@Example.com ') === await freeSampleHash(env, 'email', 'sam@example.com'));
const sampleSrc = readFileSync(join(R, 'src/routes/sample-routes.js'), 'utf8');
ok('sample route never stores an unsalted email or ip hash', !/sha256Hex\((email|ip)\)/.test(sampleSrc));
const authSrc = readFileSync(join(R, 'src/routes/auth-routes.js'), 'utf8');
ok('account export and delete use the same salted key', (authSrc.match(/freeSampleHash\(env, 'email'/g) || []).length === 2);

// 6. A blank GLOBAL_SAMPLE_CAP falls back to a small number.
ok('free-sample cap defaults to 50', (sampleSrc.match(/env\.GLOBAL_SAMPLE_CAP, 50\)/g) || []).length === 2 && !/GLOBAL_SAMPLE_CAP, \d{3,}\)/.test(sampleSrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
