// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Visual contract test for shared/render.js. Loads the renderer, runs it
// against fixed JSON inputs, hashes the resulting HTML, and compares against
// committed snapshots. Any unintended layout change fails the gate.
//
// To intentionally accept a layout change:
//   UPDATE_RENDER_SNAPSHOTS=1 node scripts/test-renderers.mjs
// That regenerates the .render-snapshots.json file. Commit that file
// alongside your render.js change so the gate locks in the new shape.
//
// Run: node scripts/test-renderers.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const renderJsPath = join(repoRoot, 'public', 'shared', 'render.js');
const snapshotPath = join(repoRoot, 'scripts', '.render-snapshots.json');

// ── Tiny DOM stub (only what render.js touches) ─────────────────
class StubElement {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this.innerHTML = '';
    this.children = [];
  }
  querySelector() { return null; }
  appendChild(c) { this.children.push(c); return c; }
}
const window = {};
const document = {
  querySelector: () => null,
  body: { classList: { add() {}, remove() {} } },
  createElement: (tag) => new StubElement(tag),
};
window.document = document;
globalThis.window = window;
globalThis.document = document;

// ── Frozen-time Date stub ─────────────────────────────────────────
// render.js inlines `new Date().toLocaleDateString(...)` for the cover-letter
// header. Without this stub the snapshot hash drifts every time the wall
// clock rolls past midnight UTC. Lock to a fixed instant so the snapshot
// only changes when render.js actually changes.
const FROZEN_TS = Date.UTC(2026, 0, 15, 12, 0, 0); // 2026-01-15T12:00:00Z
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [FROZEN_TS])); }
  static now() { return FROZEN_TS; }
}
globalThis.Date = FrozenDate;

// ── Load render.js (it's an IIFE that attaches to window.RP) ──────
const code = readFileSync(renderJsPath, 'utf8');
new Function('window', 'document', code)(window, document);
const RP = window.RP;
if (!RP) throw new Error('render.js did not register window.RP');

// ── Fixed inputs (do NOT change these without intent — the snapshots
//    are tied to these exact inputs) ─────────────────────────────────
const RESUME = {
  name: 'Jane Doe',
  title_line: 'Senior Software Engineer · Distributed Systems',
  contact: {
    email: 'jane@example.com',
    phone: '555-0100',
    location: 'Brooklyn, NY',
    links: ['github.com/janedoe', 'linkedin.com/in/janedoe'],
  },
  summary: 'Engineer with eight years building payment systems at scale.',
  skills: [
    { category: 'Languages', items: 'TypeScript, Python, Go' },
    { category: 'Infrastructure', items: 'AWS, Terraform, Kubernetes' },
  ],
  experience: [
    {
      company: 'Acme Pay',
      role: 'Senior Software Engineer',
      dates: '2021 - Present',
      location: 'Remote',
      bullets: [
        'Owned the checkout flow that processed $40M annualized.',
        'Cut p99 payment latency from 480ms to 180ms.',
      ],
    },
  ],
  education: [
    { degree: 'BS Computer Science', school: 'NYU', year: '2017' },
  ],
  projects: [
    { name: 'pdfsmith', tech: 'Rust, WASM', summary: 'Open-source PDF library, 2k stars.' },
  ],
};

const COVER = {
  name: 'Jane Doe',
  contact: { email: 'jane@example.com', phone: '555-0100', location: 'Brooklyn, NY' },
  greeting: 'Dear Initech team,',
  paragraphs: [
    'I spent the last four years building the checkout layer that moves $40M a year through Acme Pay. The role you described feels like the next chapter of that work.',
    'At Acme I led a migration from a fragmented styled-components setup to a single tokenized library across six product teams. That experience taught me how design-system decisions ripple into billing surfaces in ways that matter for compliance and user trust.',
    "I'd love to talk about how Initech is thinking about checkout latency. Free most weekday afternoons.",
  ],
  signoff: 'Best,',
};

const ANALYSIS = {
  match_score: 8,
  match_notes: 'Strong technical fit with directly relevant payments experience.',
  key_alignments: ['Owned checkout flow at $40M scale', 'Distributed systems at p99 latency'],
  potential_gaps: ['No explicit experience with Stripe Elements'],
};

// ── Run renderers and hash output ────────────────────────────────
function hash(s) { return createHash('sha256').update(s).digest('hex').slice(0, 16); }

const resumeTarget = new StubElement('div');
RP.renderResume(RESUME, resumeTarget);
const resumeHash = hash(resumeTarget.innerHTML);

const coverTarget = new StubElement('div');
RP.renderCover(COVER, coverTarget);
const coverHash = hash(coverTarget.innerHTML);

const analysisTarget = new StubElement('div');
RP.renderAnalysis(ANALYSIS, analysisTarget);
const analysisHash = hash(analysisTarget.innerHTML);

const current = { resume: resumeHash, cover: coverHash, analysis: analysisHash };

// ── Compare to snapshot OR write new ─────────────────────────────
if (process.env.UPDATE_RENDER_SNAPSHOTS === '1') {
  writeFileSync(snapshotPath, JSON.stringify(current, null, 2) + '\n');
  console.log('   updated render snapshots:');
  for (const k of Object.keys(current)) console.log(`     ${k} → ${current[k]}`);
  process.exit(0);
}

let saved;
try { saved = JSON.parse(readFileSync(snapshotPath, 'utf8')); }
catch {
  console.error('   No snapshot file found. Run with UPDATE_RENDER_SNAPSHOTS=1 once to create it.');
  process.exit(1);
}

const drift = [];
for (const k of Object.keys(current)) {
  if (saved[k] !== current[k]) drift.push(`${k}: snapshot=${saved[k]} current=${current[k]}`);
}
if (drift.length) {
  console.error('   ✗ renderer output drifted from snapshot:');
  drift.forEach(d => console.error(`     ${d}`));
  console.error('   If intentional, run: UPDATE_RENDER_SNAPSHOTS=1 node scripts/test-renderers.mjs');
  console.error('   then commit the updated scripts/.render-snapshots.json');
  process.exit(1);
}
console.log(`   resume=${resumeHash} cover=${coverHash} analysis=${analysisHash}`);
process.exit(0);
