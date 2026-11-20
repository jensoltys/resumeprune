// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Standalone test for src/lib/alert.js — the 5xx beacon contract.
// Run: node scripts/test-alerting.mjs
//
// Guards two alert bugs: an alert that can't tell test traffic from real traffic,
// and an alert with no message saying which error fired.
import {
  alertPayloadFor,
  markNoAlert,
  stripAlertHeader,
  ALERT_SKIP_HEADER,
} from '../src/lib/alert.js';

let pass = 0, fail = 0;
function eq(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else    { fail++; console.error(`  ✗ ${label}\n    expected: ${expected}\n    actual:   ${actual}`); }
}

const req = (path = '/api/sample/generate', method = 'POST') =>
  new Request(`https://resumeprune.com${path}`, { method });

const jsonRes = (body, status = 502) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

console.log('alertPayloadFor — the message must survive');
{
  const info = await alertPayloadFor(req(), jsonRes({ error: 'AI returned malformed resume. Try again.' }));
  eq('carries the error text', info.message, 'AI returned malformed resume. Try again.');
  eq('carries the path', info.path, '/api/sample/generate');
  eq('carries the method', info.method, 'POST');
  eq('carries the status', info.status, 502);
}
{
  const info = await alertPayloadFor(req(), jsonRes({ error: 'Anthropic call failed', detail: 'overloaded_error' }));
  eq('joins error + detail', info.message, 'Anthropic call failed — overloaded_error');
}
{
  const info = await alertPayloadFor(req('/unsubscribe', 'GET'), new Response('Server error', { status: 500 }));
  eq('falls back to a non-JSON body', info.message, 'Server error');
}
{
  const long = 'x'.repeat(900);
  const info = await alertPayloadFor(req(), jsonRes({ error: long }));
  eq('truncates a runaway message to 400 chars', info.message.length, 400);
}

console.log('\nalertPayloadFor — does not consume the response body');
{
  const response = jsonRes({ error: 'AI returned malformed resume. Try again.' });
  await alertPayloadFor(req(), response);
  const stillReadable = await response.json();
  eq('client can still read the body', stillReadable.error, 'AI returned malformed resume. Try again.');
}

console.log('\nmarkNoAlert — test traffic is skipped');
{
  const tagged = markNoAlert(jsonRes({ error: 'AI returned malformed resume. Try again.' }));
  eq('tag is set', tagged.headers.get(ALERT_SKIP_HEADER), '1');
  eq('status is preserved', tagged.status, 502);
  eq('no payload built for tagged responses', await alertPayloadFor(req(), tagged), null);
}

console.log('\nstripAlertHeader — the tag never reaches a client');
{
  const clean = stripAlertHeader(markNoAlert(jsonRes({ error: 'nope' })));
  eq('tag is gone', clean.headers.get(ALERT_SKIP_HEADER), null);
  eq('status survives the rebuild', clean.status, 502);
  eq('body survives the rebuild', (await clean.json()).error, 'nope');
}
{
  const untagged = jsonRes({ error: 'real outage' });
  eq('untagged responses pass through untouched', stripAlertHeader(untagged), untagged);
}

console.log('\nskipAlertForTesters — test-run 502s do not alert anyone');
{
  const { sampleGenerate } = await import('../src/routes/sample-routes.js');
  const env = { TEST_EMAILS: 'tester@example.com, tester2@example.com', TEST_BYPASS_KEY: 'test-key-123' };
  // Stub the route by driving the wrapper through the real export: a body that
  // fails validation before any Claude call still exercises the tagging path,
  // so force a 5xx with the honeypot field (an instant 502 by design).
  const post = (body, key = 'test-key-123') => new Request('https://resumeprune.com/api/sample/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-RP-Test-Key': key } : {}) },
    body: JSON.stringify(body),
  });

  const tester = await sampleGenerate(post({ email: 'tester@example.com', website: 'bot' }), env);
  eq('tester 502 is tagged', tester.headers.get(ALERT_SKIP_HEADER), '1');

  const testerCased = await sampleGenerate(post({ email: '  TESTER@Example.com ', website: 'bot' }), env);
  eq('tester match ignores case + whitespace', testerCased.headers.get(ALERT_SKIP_HEADER), '1');

  const visitor = await sampleGenerate(post({ email: 'someone@example.net', website: 'bot' }), env);
  eq('real visitor 502 still alerts', visitor.headers.get(ALERT_SKIP_HEADER), null);

  const anon = await sampleGenerate(post({ website: 'bot' }), env);
  eq('no email at all still alerts', anon.headers.get(ALERT_SKIP_HEADER), null);

  // a tester email without the secret header is a
  // real visitor, and so is a wrong key.
  const noKey = await sampleGenerate(post({ email: 'tester@example.com', website: 'bot' }, ''), env);
  eq('tester email without the key still alerts', noKey.headers.get(ALERT_SKIP_HEADER), null);
  const badKey = await sampleGenerate(post({ email: 'tester@example.com', website: 'bot' }, 'wrong-key-123'), env);
  eq('tester email with a wrong key still alerts', badKey.headers.get(ALERT_SKIP_HEADER), null);

  const noConfig = await sampleGenerate(post({ email: 'tester@example.com', website: 'bot' }), {});
  eq('unset TEST_EMAILS never suppresses', noConfig.headers.get(ALERT_SKIP_HEADER), null);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
