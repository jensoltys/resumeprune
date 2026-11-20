// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Brand-word guard. Scans user-facing HTML + shared JS for off-brand
// vocabulary that we've decided does NOT match the Resume Prune voice.
// Catches copy regressions where someone (often me) reverts "Prune your X"
// back to "Tailor your X" without noticing.
//
// Run: node scripts/test-brand-copy.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const publicDir = join(repoRoot, 'public');

// Off-brand words to flag in user-facing copy.
// "tweak" is intentionally allowed — it's part of the brand tagline
// ("Tweak any resume to fit any job in seconds"). Only "tailor*" is off-brand.
const FORBIDDEN_PATTERNS = [
  { pattern: /\btailor(ed|ing|s)?\b/gi, why: "Off-brand. Use 'prune' or 'tweak' (brand vocab)." },
  // No naming AI vendors in user-facing copy. The product is yours, and "Powered by Claude"
  // makes it feel like the vendor's. Legal pages (public/legal/) are excluded by the
  // listFiles() walker because subprocessor disclosure REQUIRES naming Anthropic.
  { pattern: /\bClaude\b/g, why: "Don't name the AI vendor in UI copy. Use 'AI' generically, or describe what the step does ('Extracting structure…')." },
  { pattern: /\bAnthropic\b/g, why: "Don't name the AI vendor in UI copy. Vendor disclosure belongs in legal/privacy pages only." },
  { pattern: /\bPowered by Claude\b/gi, why: "Drop the attribution from marketing copy. The product is yours, not the vendor's." },
];

// Files that ARE user-facing — anything served as a static asset under
// public/ that contains visible HTML or string literals.
function listFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      // Skip vendored libs — we don't author them and they may legitimately
      // contain the words in unrelated contexts.
      if (entry === 'vendor') continue;
      // Skip legal/ — Terms of Service and Privacy Policy use formal legal
      // register where 'tailored' is the standard descriptive term, not a
      // brand-voice violation.
      if (entry === 'legal') continue;
      listFiles(full, out);
    } else if (/\.(html|js|css)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const files = listFiles(publicDir);
const findings = [];
for (const f of files) {
  const content = readFileSync(f, 'utf8');
  for (const { pattern, why } of FORBIDDEN_PATTERNS) {
    pattern.lastIndex = 0; // reset regex state
    let m;
    while ((m = pattern.exec(content)) !== null) {
      // Find line number for error reporting
      const upToMatch = content.slice(0, m.index);
      const line = upToMatch.split('\n').length;
      findings.push({ file: relative(repoRoot, f), line, word: m[0], why });
    }
  }
}

if (findings.length === 0) {
  console.log(`   scanned ${files.length} files, no off-brand copy found`);
  process.exit(0);
}

console.error(`   ✗ off-brand copy in ${findings.length} place(s):`);
for (const f of findings) {
  console.error(`     ${f.file}:${f.line}  '${f.word}'  — ${f.why}`);
}
process.exit(1);
