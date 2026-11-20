// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Standalone test for parseJsonFromText in src/anthropic.js.
// Run: node scripts/test-json-parse.mjs
//
// Guards the 2026-07-29 finding: roughly 1 cover letter in 10 came back with a
// TRAILING COMMA before the closing bracket. Valid to a human, rejected by
// JSON.parse, and all three extraction paths used JSON.parse — so the whole
// generation 502'd. A test run hid it by retrying; a real visitor just
// saw "Generation failed". Captured verbatim from claude-haiku-4-5 output.
import { parseJsonFromText } from '../src/anthropic.js';

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`); }
}

console.log('happy paths still work');
ok('clean JSON', parseJsonFromText('{"a":1}')?.a === 1);
ok('fenced JSON', parseJsonFromText('```json\n{"a":1}\n```')?.a === 1);
ok('JSON wrapped in commentary', parseJsonFromText('Here you go:\n{"a":1}\nHope that helps')?.a === 1);
ok('empty text is null', parseJsonFromText('') === null);
ok('no JSON at all is null', parseJsonFromText('sorry, I cannot help with that') === null);

console.log('\ntrailing commas — the 2026-07-29 bug');
// Verbatim shape of the failure: fenced, trailing comma closing `paragraphs`.
const real = '```json\n{\n  "greeting": "Dear Aspen Health team,",\n  "paragraphs": [\n    "First para.",\n    "Second para.",\n    "Third para.",\n  ],\n  "signoff": "Best,"\n}\n```';
const parsedReal = parseJsonFromText(real);
ok('the real failing payload now parses', !!parsedReal);
ok('  keeps all 3 paragraphs', parsedReal?.paragraphs?.length === 3);
ok('  keeps the signoff', parsedReal?.signoff === 'Best,');
ok('  greeting comma untouched', parsedReal?.greeting === 'Dear Aspen Health team,');

ok('trailing comma in an object', parseJsonFromText('{"a":1,"b":2,}')?.b === 2);
ok('trailing comma in a bare array', parseJsonFromText('{"x":[1,2,]}')?.x?.length === 2);
ok('nested trailing commas', parseJsonFromText('{"a":{"b":[1,],},}')?.a?.b?.length === 1);
ok('multiple trailing commas with newlines', parseJsonFromText('{\n"a": [\n1,\n2,\n],\n}')?.a?.length === 2);

console.log('\nstring contents must never be rewritten');
// A comma-then-bracket sequence INSIDE a string is real content, not syntax.
const tricky = parseJsonFromText('{"note":"tokens: a, ] and b, } stay put","list":["x",]}');
ok('comma before ] inside a string survives', tricky?.note === 'tokens: a, ] and b, } stay put');
ok('  and the real trailing comma still got fixed', tricky?.list?.length === 1);
const escaped = parseJsonFromText('{"quote":"she said \\"hi, ]\\" loudly","n":[1,]}');
ok('escaped quotes do not break string tracking', escaped?.quote === 'she said "hi, ]" loudly');
ok('  trailing comma after escaped quotes still fixed', escaped?.n?.length === 1);
const bs = parseJsonFromText('{"path":"C:\\\\dir\\\\","n":[1,]}');
ok('a string ending in an escaped backslash does not swallow the close quote', bs?.path === 'C:\\dir\\');

console.log('\ngenuinely broken JSON is still rejected');
ok('truncated mid-object is null', parseJsonFromText('{"a": [1, 2') === null);
ok('missing value is null', parseJsonFromText('{"a": }') === null);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
