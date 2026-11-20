// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Stripe form-body serialization test. Guards the 2026-07-04 checkout outage:
// the old one-level flattener sent subscription_data.metadata.aff_ref as the
// string "[object Object]", so Stripe rejected every checkout that carried an
// affiliate ref. Any change to buildFormBody must keep arbitrary-depth
// bracket notation working.
import { buildFormBody } from '../src/lib/stripe.js';

const cases = [
  {
    name: 'scalar',
    params: { mode: 'subscription' },
    expect: [['mode', 'subscription']],
  },
  {
    name: 'array of objects (line_items)',
    params: { line_items: [{ price: 'price_123', quantity: 1 }] },
    expect: [['line_items[0][price]', 'price_123'], ['line_items[0][quantity]', '1']],
  },
  {
    name: 'one-level object (automatic_tax)',
    params: { automatic_tax: { enabled: 'true' } },
    expect: [['automatic_tax[enabled]', 'true']],
  },
  {
    name: 'two-level object (subscription_data.metadata) — the outage case',
    params: { subscription_data: { metadata: { aff_ref: 'AFF123' } } },
    expect: [['subscription_data[metadata][aff_ref]', 'AFF123']],
  },
  {
    name: 'null/undefined skipped',
    params: { customer: null, customer_email: undefined, ok: 'yes' },
    expect: [['ok', 'yes']],
  },
];

let failed = 0;
for (const c of cases) {
  const got = [...buildFormBody(c.params).entries()];
  const want = c.expect;
  const match = got.length === want.length && want.every(([k, v], i) => got[i][0] === k && got[i][1] === v);
  if (!match) {
    failed++;
    console.error(`   ✗ ${c.name}\n     want ${JSON.stringify(want)}\n     got  ${JSON.stringify(got)}`);
  }
}
const objectObject = [...buildFormBody({ a: { b: { c: { d: 'deep' } } } }).values()].some(v => v.includes('[object Object]'));
if (objectObject) { failed++; console.error('   ✗ deep nesting produced "[object Object]"'); }

if (failed) process.exit(1);
console.log(`   ✓ stripe param serialization holds (${cases.length + 1} cases)`);
