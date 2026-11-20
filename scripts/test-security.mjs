// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Security regression scanner. Runs as a pre-deploy gate.
// The point of this gate is to catch the same class of issue twice — every
// time a security check turns up a problem, we add a check here so the same
// thing can't silently regress in a future change.
//
// Run: node scripts/test-security.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function listFiles(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (entry === 'vendor' || entry === 'node_modules' || entry === '.wrangler' || entry === 'dist' || entry === 'build') continue;
      listFiles(full, exts, out);
    } else if (exts.some(e => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

const findings = [];
function flag(severity, file, line, rule, detail) {
  findings.push({ severity, file: relative(repoRoot, file), line, rule, detail });
}

// ── Source code checks (src/) ──────────────────────────────────────────────
const srcFiles = listFiles(join(repoRoot, 'src'), ['.js']);

for (const f of srcFiles) {
  const content = readFileSync(f, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    const ln = idx + 1;

    // SELECT * — never allowed; columns must be explicit.
    if (/\bSELECT\s+\*/i.test(line) && !/--.*SELECT \*/i.test(line)) {
      flag('HIGH', f, ln, 'SELECT *', 'Explicitly list columns. Prevents leaking new sensitive columns added later (e.g. pw_hash, token_version).');
    }

    // CORS wildcard.
    if (/Access-Control-Allow-Origin['"\s:,]+\*/.test(line)) {
      flag('HIGH', f, ln, 'CORS wildcard', 'Origin allowlist is required when credentials are sent. Never `*`.');
    }

    // Hardcoded secret patterns (Anthropic, Resend, Stripe live, OpenAI, Slack, Google, GitHub).
    if (/sk-ant-api03-[A-Za-z0-9_-]{20,}/.test(line)) flag('HIGH', f, ln, 'hardcoded ANTHROPIC key', 'Move to wrangler secret.');
    if (/\bre_[A-Za-z0-9]{20,}/.test(line))            flag('HIGH', f, ln, 'hardcoded RESEND key', 'Move to wrangler secret.');
    if (/sk_live_[A-Za-z0-9]{20,}/.test(line))         flag('HIGH', f, ln, 'hardcoded STRIPE live key', 'Move to wrangler secret.');
    if (/sk-[A-Za-z0-9]{40,}/.test(line) && !/sk-ant/.test(line)) flag('HIGH', f, ln, 'hardcoded OpenAI-shaped key', 'Move to wrangler secret.');
    if (/xox[baprs]-[A-Za-z0-9-]{20,}/.test(line))     flag('HIGH', f, ln, 'hardcoded Slack token', 'Move to secret store.');
    if (/AIza[A-Za-z0-9_-]{30,}/.test(line))           flag('HIGH', f, ln, 'hardcoded Google API key', 'Move to secret store.');
    if (/ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/.test(line)) flag('HIGH', f, ln, 'hardcoded GitHub PAT', 'Move to secret store.');

    // PII / secrets in console logs — emails, tokens, passwords, raw bodies.
    // False positive risk: log lines that mention these only as labels. Tune by
    // requiring a variable-like access pattern (dotted property, bracket, or bare
    // identifier match). Whitelist any line containing 'env.' so secret-existence
    // checks like `console.error('RESEND_API_KEY not set')` don't false-positive.
    if (/console\.(log|error|warn|info|debug)\s*\([^)]*\b(password|passwordHash|pw_hash|token|jwt|apiKey|api_key|secret|authorization|req\.body|request\.body|resumeText|raw_text|jd\b)\b/i.test(line)
        && !/['"`][^'"`]*(password|token|jwt|secret|api_key|apiKey)[^'"`]*['"`]/i.test(line.replace(/console\.[a-z]+\s*\(/i, ''))) {
      // Suppress if the only match is a literal string label (e.g. console.error('Token expired'))
      if (!/['"]\s*[^'"]*(password|token|secret|api[_-]?key)[^'"]*['"]\s*\)/i.test(line)) {
        flag('MEDIUM', f, ln, 'PII / secret in console log', 'Log identifier (user_id, request_id) — never the data.');
      }
    }

    // Storing sensitive values in localStorage / sessionStorage.
    // localStorage is readable by any script — XSS instantly drains it. Use HttpOnly cookies for auth state.
    if (/(localStorage|sessionStorage)\.setItem\s*\(\s*['"`][^'"`]*(password|token|jwt|secret|apiKey|api_key|credit|card|ssn)/i.test(line)) {
      flag('HIGH', f, ln, 'sensitive data in browser storage', 'Use HttpOnly cookies for auth; never localStorage.');
    }

    // Stripe price IDs in source — should be server-side allowlisted, not client-supplied.
    // Catches the "checkout takes a price_id from the request body" pattern that lets users self-select free tier.
    if (/price_[A-Za-z0-9]{14,}/.test(line) && /public\/|client\/|browser/i.test(f)) {
      flag('HIGH', f, ln, 'Stripe price_id in client code', 'Whitelist price_ids server-side; never accept from client.');
    }

    // 429 response without Retry-After — clients can't back off cleanly.
    // Look for explicit 429 status setting and check ±10 lines for Retry-After.
    if (/\bstatus\s*[:=]\s*429\b/.test(line) || /\.status\(429\)/.test(line) || /,\s*429\b/.test(line)) {
      const window = lines.slice(Math.max(0, idx - 5), Math.min(lines.length, idx + 10)).join('\n');
      if (!/Retry-After/i.test(window)) {
        flag('MEDIUM', f, ln, '429 without Retry-After', 'Add Retry-After header so clients know when to retry.');
      }
    }
  });

  // Module-level mutable CORS / state (the race we just fixed).
  // Allow per-request stores like AsyncLocalStorage; flag bare module-scope `let _cors`.
  if (/^\s*let\s+_cors\s*=/m.test(content)) {
    flag('HIGH', f, 0, 'module-level CORS state', 'Use AsyncLocalStorage so concurrent requests on the same isolate don\'t race.');
  }

  // ── Route and page checks ───────────────────────────────────

  // Pre-hijack account takeover. Signup on an existing UNVERIFIED row must take
  // over the credentials (new pw_hash, token_version bump, fresh code) and
  // login must refuse unverified rows. Both halves or neither: a takeover
  // without the login gate would let anyone reset an unverified-but-active
  // account's password blind.
  const signupMatch = content.match(/export\s+async\s+function\s+signup\s*\([^)]*\)\s*\{([\s\S]{0,3500})/);
  if (signupMatch && !/email_verified/.test(signupMatch[1])) {
    flag('HIGH', f, 0, 'signup ignores unverified rows', 'An unverified existing row must get the new pw_hash, a token_version bump, and a fresh code.');
  }
  const loginMatch = content.match(/export\s+async\s+function\s+login\s*\([^)]*\)\s*\{([\s\S]{0,3500})/);
  if (loginMatch && !/email_not_verified/.test(loginMatch[1])) {
    flag('HIGH', f, 0, 'login does not refuse unverified rows', "After the password check, return 403 code 'email_not_verified' when email_verified is 0.");
  }

  // ── AI cost and webhook checks ────────────────────────────────────────────

  // MED-1: public LLM cost-bomb. The free-sample route file calls Claude
  // (callClaude). Its expensive paths must be gated by BOTH a bot check
  // (verifyTurnstile) AND a global cap, not just a per-IP rate limit (which
  // IP-rotation defeats). Heuristic: if a file calls callClaude and contains an
  // /api/sample/ route, it must reference verifyTurnstile AND a global cap key.
  if (/callClaude\s*\(/.test(content) && /\/api\/sample\//.test(content)) {
    if (!/verifyTurnstile/.test(content)) {
      flag('MEDIUM', f, 0, 'public LLM endpoint without Turnstile on every Claude path',
        'A public /api/sample/ route calls Claude. Gate EVERY Claude call (analyze + generate) behind Turnstile so IP-rotation cannot run up an Anthropic bill.');
    }
    if (!/global[:_-]?sample|globalCap|circuit[_-]?breaker/i.test(content)) {
      flag('MEDIUM', f, 0, 'public LLM endpoint without global cap',
        'Per-IP limits do not stop distributed abuse. Add a global daily ceiling on free-sample Claude calls.');
    }
  }

  // MED-2: Stripe webhook idempotency must be a PRE-FLIGHT lock, not recorded
  // after the side effects. A webhook handler that runs UPDATE/conversion calls
  // before claiming the event id leaves a concurrent-replay window. The hardened
  // pattern (2026-06-06): as the FIRST DB op, INSERT OR IGNORE the event id into a
  // dedup table (webhook_events or payment_events) and early-return when 0 rows
  // changed. We detect the Stripe webhook handler by its signature-verify call,
  // then require both halves of the lock-first pattern to be present.
  // Anchor on the handler (calls verifyWebhook AND writes the payment_events audit
  // row), not the verify library that merely defines verifyWebhook.
  if (/verifyWebhook\s*\(/.test(content) && /payment_events/.test(content)) {
    const hasLockInsert = /INSERT\s+OR\s+IGNORE\s+INTO\s+(webhook_events|payment_events)/i.test(content);
    // Early-return guard on a zero-change result (meta.changes === 0 / !changes).
    const hasZeroChangeGuard = /meta(\?\.|\.)changes\s*===?\s*0/.test(content)
      || /changes\s*===?\s*0/.test(content);
    if (!hasLockInsert || !hasZeroChangeGuard) {
      const ln = content.slice(0, content.search(/verifyWebhook\s*\(/)).split('\n').length;
      flag('MEDIUM', f, ln, 'webhook idempotency not lock-first',
        'Claim the Stripe event id with a pre-flight INSERT OR IGNORE (webhook_events/payment_events) and early-return on 0 changes, BEFORE any side effects, so concurrent Stripe replays cannot double-process.');
    }
  }

  // CSP `'unsafe-inline'` for scripts. Style is acceptable; script is not.
  // Match script-src lines that contain 'unsafe-inline' (any quote style).
  const cspMatch = content.match(/script-src[^;'"]*['"]unsafe-inline['"][^;]*/i);
  if (cspMatch) {
    flag('HIGH', f, 0, 'CSP script unsafe-inline', 'Use nonces or external scripts. unsafe-inline negates CSP\'s XSS protection.');
  }
}

// ── MED-3: every env secret referenced in source must be documented ─────────
// An undocumented secret (e.g. CONVERSION_WEBHOOK_SECRET) can silently be unset
// in prod, sending empty-auth requests. Cross-check env.*_SECRET / env.*_KEY
// references in src/ against the wrangler.toml secrets comment block.
{
  const wranglerPath = join(repoRoot, 'wrangler.toml');
  const wrangler = existsSync(wranglerPath) ? readFileSync(wranglerPath, 'utf8') : '';
  const secretRefs = new Set();
  for (const f of srcFiles) {
    const c = readFileSync(f, 'utf8');
    let m2;
    const re = /env\.([A-Z][A-Z0-9_]*(?:SECRET|_KEY|API_KEY))\b/g;
    while ((m2 = re.exec(c)) !== null) secretRefs.add(m2[1]);
  }
  for (const name of secretRefs) {
    if (!wrangler.includes(name)) {
      flag('MEDIUM', wranglerPath, 0, `undocumented secret ${name}`,
        `${name} is read from env in source but not listed in wrangler.toml. Document it in the secrets block and confirm it is set in prod.`);
    }
  }
}

// ── worker.js — verify every API route uses `return await` ─────────────────
// The bug we hit: `return tweakAnalyze(...)` (no await) lets typed-Response
// rejections escape the try/catch and surface as 500s.
const workerJs = readFileSync(join(repoRoot, 'src', 'worker.js'), 'utf8');
const routeCallRe = /^\s*if\s*\(p\s*===?\s*['"`]\/api\/[^'"`]+['"`].*?\)\s*return\s+([a-zA-Z])/gm;
let m;
while ((m = routeCallRe.exec(workerJs)) !== null) {
  // The capture is the first letter of what follows `return `.
  // We expect `await` here. If it's a function name (capital or lowercase letter)
  // not preceded by `await`, that's the bug.
  const fragment = workerJs.slice(m.index, m.index + 200);
  if (!/return\s+await\s/.test(fragment)) {
    const lineNum = workerJs.slice(0, m.index).split('\n').length;
    flag('MEDIUM', join(repoRoot, 'src', 'worker.js'), lineNum, 'route missing `return await`', 'Async rejections leak as 500s instead of being caught by the outer try/catch.');
  }
}

// ── HTML asset checks (public/) ────────────────────────────────────────────
const htmlFiles = listFiles(join(repoRoot, 'public'), ['.html']);

for (const f of htmlFiles) {
  const content = readFileSync(f, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    const ln = idx + 1;

    // target=_blank without rel=noopener on the same tag.
    // We only check this on <a> tags.
    const linkRe = /<a\b[^>]*\btarget\s*=\s*["']_blank["'][^>]*>/gi;
    const matches = line.match(linkRe);
    if (matches) {
      for (const tag of matches) {
        if (!/\brel\s*=\s*["'][^"']*\bnoopener\b/i.test(tag)) {
          flag('LOW', f, ln, 'target=_blank without rel=noopener', tag.slice(0, 80));
        }
      }
    }

    // Inline event handlers (onclick="...", onsubmit="...", etc.) are
    // BLOCKED by strict CSP (no 'unsafe-inline' on script-src). Nonces don't
    // apply to inline event handlers. We removed unsafe-inline in the
    // 2026-05-10 security pass; this gate ensures nobody adds an onclick
    // expecting it to work. Use addEventListener in a nonced <script> tag.
    const inlineEventRe = /\son(click|submit|change|load|blur|focus|input|keydown|keyup|keypress|mouseover|mouseout|mousedown|mouseup)\s*=\s*["']/gi;
    if (inlineEventRe.test(line)) {
      flag('HIGH', f, ln, 'inline event handler blocked by strict CSP', line.trim().slice(0, 100));
    }

    // CDN script without SRI hash. CDN drift / takeover risk.
    const cdnScript = line.match(/<script[^>]+src\s*=\s*["']https:\/\/(cdn\.|unpkg\.|cdnjs\.)[^"']+["'][^>]*>/gi);
    if (cdnScript) {
      for (const tag of cdnScript) {
        if (!/\bintegrity\s*=/i.test(tag)) {
          flag('MEDIUM', f, ln, 'CDN script without SRI', tag.slice(0, 80));
        }
      }
    }

    // Newsletter / marketing consent checkbox default-checked — GDPR + ePrivacy violation.
    // Consent must be opt-in (unchecked default). Pre-checked = invalid consent.
    const checkboxMatches = line.match(/<input\b[^>]*\btype\s*=\s*["']checkbox["'][^>]*>/gi);
    if (checkboxMatches) {
      for (const tag of checkboxMatches) {
        if (/\b(newsletter|marketing|subscribe|opt[-_]?in|promo|emails?)\b/i.test(tag) && /\bchecked\b/i.test(tag)) {
          flag('HIGH', f, ln, 'consent checkbox default-checked', 'Pre-checked consent boxes violate GDPR/ePrivacy. Default unchecked.');
        }
      }
    }

    // Stripe price_id rendered in HTML — client-side price selection is exploitable.
    if (/price_[A-Za-z0-9]{14,}/.test(line)) {
      flag('HIGH', f, ln, 'Stripe price_id in HTML', 'Server should choose price_id by tier name, never trust client.');
    }
  });

  // Missing privacy policy link on user-facing pages (index/landing/signup).
  // Heuristic: top-level *.html that mentions email/signup but doesn't link to /privacy.
  if (/(index|landing|home|signup|signin|login)\.html$/i.test(f)) {
    const looksLikeUserPage = /<form|email|sign\s*up|sign\s*in|subscribe/i.test(content);
    const hasPrivacyLink = /href\s*=\s*["'][^"']*(privacy|legal)/i.test(content);
    // The shared footer.js injects privacy/terms links on every page, so allow
    // pages that include footer.js to satisfy this check.
    const hasSharedFooter = /shared\/footer\.js/i.test(content);
    if (looksLikeUserPage && !hasPrivacyLink && !hasSharedFooter) {
      flag('MEDIUM', f, 0, 'no privacy policy link on user-facing page', 'GDPR/CCPA require accessible privacy notice from every collection point.');
    }
  }
}

// ── Migration checks ────────────────────────────────────────────────────────
const migrationFiles = readdirSync(join(repoRoot, 'migrations')).filter(f => f.endsWith('.sql'));
const usersTableMigration = migrationFiles
  .map(f => ({ name: f, content: readFileSync(join(repoRoot, 'migrations', f), 'utf8') }))
  .find(f => /CREATE TABLE users/i.test(f.content));

if (usersTableMigration) {
  // token_version must exist. We don't enforce it in 0001 (added in 0004), but
  // *some* migration in the chain must add it.
  const allMigrationContent = migrationFiles
    .map(f => readFileSync(join(repoRoot, 'migrations', f), 'utf8'))
    .join('\n');
  if (!/token_version/i.test(allMigrationContent)) {
    flag('HIGH', join(repoRoot, 'migrations'), 0, 'users.token_version missing', 'JWT revocation requires token_version column. See migration 0004.');
  }
}

// ── Guest checkout / claim invariants ───────────
// The checkout-first flow (create-checkout-guest → webhook/claim) has four
// invariants a refactor must never lose. Checked as whole-file predicates on
// stripe-routes.js rather than line regexes because they span functions.
{
  const stripeRoutesPath = join(repoRoot, 'src', 'routes', 'stripe-routes.js');
  if (existsSync(stripeRoutesPath)) {
    const sr = readFileSync(stripeRoutesPath, 'utf8');
    // 1. Claim can only set a password over the guest sentinel — the UPDATE
    //    must be guarded in SQL, not just in JS, so concurrent claims and
    //    future code paths can't overwrite an established password.
    if (!/UPDATE users SET pw_hash[\s\S]{0,200}WHERE[\s\S]{0,100}pw_hash LIKE/.test(sr)) {
      flag('HIGH', stripeRoutesPath, 0, 'claim sentinel guard missing', 'stripeClaim must guard the pw_hash UPDATE with WHERE pw_hash LIKE <guest sentinel>. A paid session id must never take over an established account.');
    }
    // 2. Guest sessions only ever link after Stripe says the checkout settled.
    if (!/function sessionSettled/.test(sr) || (sr.match(/sessionSettled\(/g) || []).length < 3) {
      flag('HIGH', stripeRoutesPath, 0, 'settled-payment gate missing', 'linkGuestSessionToUser callers (webhook, claim-info, claim) must all gate on sessionSettled().');
    }
    // 3. Session ids are validated as cs_ tokens before hitting the Stripe API.
    if (!/\^cs_\[A-Za-z0-9_\]/.test(sr)) {
      flag('HIGH', stripeRoutesPath, 0, 'session_id shape check missing', 'claim/claim-info must validate session_id against ^cs_[A-Za-z0-9_]{10,200}$ before use.');
    }
    // 4. Stripe doesn't prove who owns a checkout email, so a guest purchase on an
    //    address with an account cancels the NEW subscription, never the existing one.
    if (!/cancelSubscription\(env, session\.subscription\)/.test(sr) || /cancelSubscription\(env, user\.stripe_subscription_id\)[\s\S]{0,200}guest checkout/.test(sr)) {
      flag('HIGH', stripeRoutesPath, 0, 'guest checkout can disturb an account', 'linkGuestSessionToUser must cancel the new guest subscription and leave the existing account alone.');
    }
  }
  // 5. Feedback widget stays logged-in-only: the session check must run before
  //    the widget builds any DOM.
  const fbwPath = join(repoRoot, 'public', 'shared', 'feedback-widget.js');
  if (existsSync(fbwPath)) {
    const fbw = readFileSync(fbwPath, 'utf8');
    if (!/fetch\(['"]\/api\/profile['"]/.test(fbw) || !/initWidget/.test(fbw)) {
      flag('MEDIUM', fbwPath, 0, 'feedback widget auth gate missing', 'Widget must check /api/profile and only render for logged-in users.');
    }
  }
}

// ── 2026-07-04 sweep addition: rate-limit accounting must fail open ─────────
// rate_limits had PRIMARY KEY (key, ts); same-second same-key bursts threw
// SQLITE_CONSTRAINT and 500'd whole routes (including guest checkout — a
// double-clicked plan CTA). Migration 0012 dropped the PK, and the inserts in
// ratelimit.js are try-guarded so accounting failures can never take down the
// route they protect.
{
  const rlPath = join(repoRoot, 'src', 'ratelimit.js');
  if (existsSync(rlPath)) {
    const rl = readFileSync(rlPath, 'utf8');
    const guardedInserts = (rl.match(/try\s*\{[\s\S]{0,200}?INSERT INTO rate_limits/g) || []).length;
    const totalInserts = (rl.match(/INSERT INTO rate_limits/g) || []).length;
    if (guardedInserts < totalInserts) {
      flag('HIGH', rlPath, 0, 'unguarded rate_limits insert', 'Every INSERT INTO rate_limits must be inside try/catch (fail open). An accounting error must never 500 the route it protects — see migration 0012.');
    }
  }
  const migrationNames = readdirSync(join(repoRoot, 'migrations')).filter(f => f.endsWith('.sql'));
  if (!migrationNames.some(f => /rate_limits_drop_pk/.test(f))) {
    flag('HIGH', join(repoRoot, 'migrations'), 0, 'rate_limits PK migration missing', 'Migration 0012_rate_limits_drop_pk.sql must exist — the (key, ts) PK caused same-second 500s on money paths.');
  }
}

// ── Phase 6.2: hosted resume pages (/r/:slug) invariants ────────────────────
// The public page is unauthenticated and server-renders HTML from user-owned
// data (the resume) plus user-supplied config (headline, accent, links). The
// invariants that must never regress:
//  1. XSS: output must be HTML-escaped (escHtml). All resume/headline/link text
//     is attacker-influenced and is interpolated straight into markup.
//  2. The public lookup must filter unpublished_at IS NULL, or an unpublished
//     ("deleted") link would keep serving a live resume.
//  3. Only resume_json leaves the server for the public page — never
//     analysis_json / cover_json / jd (that would leak the private match report).
//  4. The accent color must be validated against a strict hex regex before it is
//     interpolated into inline CSS (`--accent`), or it's a CSS-injection vector.
//  5. User link URLs must be protocol-checked (http/https only) so a
//     `javascript:`/`data:` URL can never become an href.
//  6. Page style must be checked against an allowlist, not trusted from input.
{
  const pagesPath = join(repoRoot, 'src', 'routes', 'pages-routes.js');
  if (existsSync(pagesPath)) {
    const pr = readFileSync(pagesPath, 'utf8');
    if (/resumePagePublic/.test(pr)) {
      if (!/function escHtml/.test(pr)) {
        flag('HIGH', pagesPath, 0, 'hosted-resume HTML escaping missing', 'The server-rendered /r/:slug page must escape all user-derived text with escHtml() before interpolating into HTML.');
      }
      if (!/unpublished_at IS NULL/.test(pr)) {
        flag('HIGH', pagesPath, 0, 'hosted-resume unpublish filter missing', 'The public lookup must filter `unpublished_at IS NULL` — an unpublished link must stop serving immediately.');
      }
      if (/rp\.[\s\S]{0,140}(analysis_json|cover_json)/.test(pr) || /(analysis_json|cover_json)[\s\S]{0,60}FROM tweaks t JOIN resume_pages/.test(pr)) {
        flag('HIGH', pagesPath, 0, 'hosted-resume leaks private fields', 'The public page query must select only resume_json from tweaks — never analysis_json/cover_json/jd.');
      }
      if (!/ACCENT_RE\s*=\s*\/\^#\[0-9a-f\]\{6\}\$\//.test(pr) || !/ACCENT_RE\.test/.test(pr)) {
        flag('HIGH', pagesPath, 0, 'hosted-resume accent not hex-validated', 'The accent color must be validated with a strict ^#[0-9a-f]{6}$ regex before it is interpolated into inline CSS (--accent).');
      }
      if (!/function safeUrl/.test(pr) || !/parsed\.protocol/.test(pr)) {
        flag('HIGH', pagesPath, 0, 'hosted-resume link URL not protocol-checked', 'User link URLs must pass safeUrl() (http/https only, via parsed.protocol) so a javascript:/data: URL can never become an href.');
      }
      if (!/STYLES\s*=\s*new Set\(/.test(pr) || !/STYLES\.has/.test(pr)) {
        flag('HIGH', pagesPath, 0, 'hosted-resume style not allowlisted', 'Page style must be checked against the STYLES allowlist, never trusted from input.');
      }
    }
  }
}

// ── Open redirect: ?next= after log-in (fixed 2026-11-04) ────────────────
// `next.startsWith('/')` let //evil.site and /\evil.site through. Any page that
// reads ?next= must resolve it with new URL() and require a same-origin match,
// and safeNext() in login.html is run here against the known bypasses.
{
  const pubFiles = listFiles(join(repoRoot, 'public'), ['.html', '.js']);
  for (const f of pubFiles) {
    const c = readFileSync(f, 'utf8');
    if (!/searchParams\.get\(\s*['"]next['"]\s*\)|\.get\(\s*['"]next['"]\s*\)/.test(c)) continue;
    if (/next\s*&&\s*next\.startsWith\(\s*['"]\/['"]\s*\)/.test(c) || !/\.origin\s*!==\s*location\.origin/.test(c)) {
      flag('HIGH', f, 0, 'open redirect via ?next=', "Resolve ?next= with new URL(next, location.origin) and require u.origin === location.origin before navigating.");
    }
  }
  const loginPath = join(repoRoot, 'public', 'login.html');
  const lc = existsSync(loginPath) ? readFileSync(loginPath, 'utf8') : '';
  const m = lc.match(/function safeNext\(next\)\s*\{[\s\S]*?\n\}/);
  if (!m) {
    flag('HIGH', loginPath, 0, 'safeNext missing', 'login.html must route ?next= through safeNext().');
  } else {
    const location = { origin: 'https://resumeprune.test' };
    const safeNext = new Function('location', 'URL', m[0] + '\nreturn safeNext;')(location, URL);
    const bad = ['//evil.site', '/\\evil.site', '/\\/evil.site', '/.//evil.site', '/x/..//evil.site', '/./\\evil.site',
      'https://evil.site', 'https://evil.site/app.html', 'javascript:alert(1)', '\\\\evil.site', ' //evil.site'];
    for (const b of bad) {
      const out = safeNext(b);
      if (out !== null) flag('HIGH', loginPath, 0, 'safeNext lets an off-site next through', JSON.stringify(b) + ' -> ' + JSON.stringify(out));
    }
    const O = location.origin;
    for (const [inp, want] of [['/app.html', O + '/app.html'], ['/account.html?x=1#y', O + '/account.html?x=1#y'], ['/onboarding.html', O + '/onboarding.html']]) {
      if (safeNext(inp) !== want) flag('HIGH', loginPath, 0, 'safeNext breaks a same-site next', JSON.stringify(inp) + ' -> ' + JSON.stringify(safeNext(inp)));
    }
  }
}

// ── Report ─────────────────────────────────────────────────────────────────
if (findings.length === 0) {
  console.log(`   scanned ${srcFiles.length} src + ${htmlFiles.length} html files, no security regressions found`);
  process.exit(0);
}

const high = findings.filter(f => f.severity === 'HIGH');
const med  = findings.filter(f => f.severity === 'MEDIUM');
const low  = findings.filter(f => f.severity === 'LOW');

console.error(`   ✗ security scan: ${high.length} HIGH, ${med.length} MEDIUM, ${low.length} LOW`);
for (const f of findings) {
  const where = f.line ? `${f.file}:${f.line}` : f.file;
  console.error(`     [${f.severity}] ${where}  '${f.rule}'  — ${f.detail}`);
}

// Block the deploy on HIGH; warn-only on MEDIUM/LOW.
if (high.length > 0) process.exit(1);
console.error('   (warnings only — deploy continues)');
process.exit(0);
