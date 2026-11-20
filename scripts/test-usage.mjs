// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Standalone test for src/lib/usage.js period-key helpers.
// Run: node scripts/test-usage.mjs
import { periodKeyFor, planLimit, isUnderLimit } from '../src/lib/usage.js';

let pass = 0, fail = 0;
function eq(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else    { fail++; console.error(`  ✗ ${label}\n    expected: ${expected}\n    actual:   ${actual}`); }
}

console.log('periodKeyFor');
// 2026-05-09 is a Saturday in ISO week 19 of 2026.
eq("Pro plan returns YYYY-MM", periodKeyFor('pro', new Date('2026-05-09T12:00:00Z')), '2026-05');
eq("Sprint plan returns YYYY-Www", periodKeyFor('sprint', new Date('2026-05-09T12:00:00Z')), '2026-W19');
eq("Free plan returns YYYY-MM (default)", periodKeyFor('free', new Date('2026-05-09T12:00:00Z')), '2026-05');
// 2027-01-01 is Friday → ISO week 53 of 2026 (Mon 2026-12-28 to Sun 2027-01-03).
eq("Sprint at year boundary lands in 2026-W53", periodKeyFor('sprint', new Date('2027-01-01T12:00:00Z')), '2026-W53');
// 2026-01-01 is Thursday → ISO week 1 of 2026.
eq("Sprint at start of year is 2026-W01", periodKeyFor('sprint', new Date('2026-01-01T12:00:00Z')), '2026-W01');

console.log('\nplanLimit');
eq("Pro = 40", planLimit('pro'), 40);
eq("Sprint = 20", planLimit('sprint'), 20);
eq("Free = 0 (no Pro tweaks)", planLimit('free'), 0);
eq("Unknown = 0", planLimit('mystery'), 0);

console.log('\nisUnderLimit');
eq("Pro under: 39 < 40", isUnderLimit('pro', 39), true);
eq("Pro at: 40 NOT under", isUnderLimit('pro', 40), false);
eq("Pro over: 41 NOT under", isUnderLimit('pro', 41), false);
eq("Sprint under: 19 < 20", isUnderLimit('sprint', 19), true);
eq("Sprint at: 20 NOT under", isUnderLimit('sprint', 20), false);
eq("Free always blocked", isUnderLimit('free', 0), false);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
