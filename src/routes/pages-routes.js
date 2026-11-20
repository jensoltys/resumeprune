// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
import { res, readJson, nowSec, uuid, requireSameOrigin } from '../helpers.js';
import { requireAuth } from '../auth.js';
import { rateLimit } from '../ratelimit.js';
import { effectivePlan, planLimit } from '../lib/usage.js';

// Phase 6.2 — Hosted online resume (Pro).
// The public /r/:slug page is a HUMAN-facing artifact (a recruiter clicking a
// link), not an ATS document — so it gets its own look: a chosen style, an
// accent color, an optional headline, and custom links the person adds. It is
// rendered SERVER-SIDE (so the "let search engines find it" toggle works and
// the page survives with JS off). The ATS PDF uses a different renderer and is
// untouched. Only the resume is ever public — never the analysis, cuts, or JD.

const SLUG_RE = /^[a-z0-9-]{3,40}$/;
const ACCENT_RE = /^#[0-9a-f]{6}$/;
const STYLES = new Set(['modern', 'warm', 'editorial']);
const MAX_LIVE_PAGES = 5;
const HEADLINE_MAX = 120;
const MAX_LINKS = 6;
const LINK_LABEL_MAX = 40;
const URL_MAX = 300;

const RESERVED_SLUGS = new Set([
  'app', 'try', 'api', 'claim', 'account', 'admin', 'sample', 'r',
  'index', 'login', 'signup', 'onboarding', 'legal', 'verify-email',
  'reset-password', 'favicon', 'shared', 'vendor', 'og', 'unsubscribe',
  'health', 'config', 'robots', 'sitemap',
]);

// Only the fields the resume renderer reads ever leave the server. Drops
// pruning_notes (the private "what got cut" report) and anything else the
// tailor stage attached.
function publicResume(r) {
  if (!r || typeof r !== 'object') return null;
  const c = r.contact && typeof r.contact === 'object' ? r.contact : {};
  return {
    name: r.name,
    title_line: r.title_line,
    contact: { email: c.email, phone: c.phone, location: c.location },
    summary: r.summary,
    skills: Array.isArray(r.skills) ? r.skills : [],
    experience: Array.isArray(r.experience) ? r.experience : [],
    education: Array.isArray(r.education) ? r.education : [],
    projects: Array.isArray(r.projects) ? r.projects : [],
  };
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// A user-supplied link URL is only allowed to be http/https. Bare hosts get
// https:// prepended so "linkedin.com/in/x" works. Returns a safe absolute URL
// or null. This is the guard that keeps javascript:/data: URLs off the page.
function safeUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return null;
  if (u.length > URL_MAX) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
  let parsed;
  try { parsed = new URL(u); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname.includes('.')) return null;
  return parsed.href;
}

// Validate the human-facing config (style/accent/headline/links). On create,
// missing fields fall back to defaults; on PATCH (partial=true), missing fields
// are left untouched by the caller. Throws a 400 Response on bad input.
function validateConfig(body, { partial } = {}) {
  const out = {};

  if (body.style !== undefined || !partial) {
    const style = typeof body.style === 'string' ? body.style.trim().toLowerCase() : 'modern';
    if (!STYLES.has(style)) throw res({ error: 'Pick a page style: modern, warm, or editorial.' }, 400);
    out.style = style;
  }

  if (body.accent !== undefined || !partial) {
    const accent = (typeof body.accent === 'string' ? body.accent.trim().toLowerCase() : '#4f46e5');
    if (!ACCENT_RE.test(accent)) throw res({ error: 'Accent color must be a hex value like #4f46e5.' }, 400);
    out.accent = accent;
  }

  if (body.headline !== undefined || !partial) {
    let headline = typeof body.headline === 'string' ? body.headline.replace(/\s+/g, ' ').trim() : '';
    if (headline.length > HEADLINE_MAX) throw res({ error: `Keep the headline under ${HEADLINE_MAX} characters.` }, 400);
    out.headline = headline || null;
  }

  if (body.links !== undefined || !partial) {
    const raw = Array.isArray(body.links) ? body.links : [];
    if (raw.length > MAX_LINKS) throw res({ error: `You can add up to ${MAX_LINKS} links.` }, 400);
    const links = [];
    for (const item of raw) {
      const label = typeof item?.label === 'string' ? item.label.replace(/\s+/g, ' ').trim() : '';
      const url = safeUrl(item?.url);
      if (!label && !url) continue;               // skip blank rows
      if (!label || label.length > LINK_LABEL_MAX) throw res({ error: `Each link needs a short label (max ${LINK_LABEL_MAX} characters).` }, 400);
      if (!url) throw res({ error: `"${label}" needs a valid web address (http/https).` }, 400);
      links.push({ label, url });
    }
    out.links = links;
    out.links_json = links.length ? JSON.stringify(links) : null;
  }

  return out;
}

async function requirePro(env, uid) {
  const user = await env.DB.prepare(
    `SELECT plan, plan_expires, stripe_subscription_id FROM users WHERE id = ?`
  ).bind(uid).first();
  if (!user) throw res({ error: 'User not found' }, 404);
  if (planLimit(effectivePlan(user, env)) === 0) {
    throw res({
      error: 'Publishing a resume link is for paid plans. Pick a paid plan.',
      code: 'NO_PLAN',
    }, 402);
  }
}

function pageRow(r) {
  return {
    id: r.id, tweak_id: r.tweak_id, slug: r.slug, indexable: r.indexable,
    view_count: r.view_count, published_at: r.published_at,
    style: r.style, accent: r.accent, headline: r.headline,
    links: r.links_json ? safeParseLinks(r.links_json) : [],
  };
}
function safeParseLinks(json) {
  try { const a = JSON.parse(json); return Array.isArray(a) ? a : []; } catch { return []; }
}

// POST /api/resume-pages  body: { tweak_id, slug, indexable?, style?, accent?, headline?, links? }
export async function resumePageCreate(request, env) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const uid = await requireAuth(request, env);
  const burst = await rateLimit(request, env, 'resume-page', 10, 60, `uid:${uid}:resume-page`);
  if (burst) return burst;
  await requirePro(env, uid);

  const body = await readJson(request);
  const tweakId = typeof body.tweak_id === 'string' ? body.tweak_id.trim() : '';
  const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '';
  const indexable = body.indexable === true ? 1 : 0;
  const cfg = validateConfig(body, { partial: false });

  if (!SLUG_RE.test(slug)) throw res({ error: 'Link name must be 3–40 characters: lowercase letters, numbers, and hyphens only.' }, 400);
  if (RESERVED_SLUGS.has(slug)) throw res({ error: 'That link name is reserved. Try another.' }, 400);

  const tweak = await env.DB.prepare(`SELECT uid, resume_json FROM tweaks WHERE id = ?`).bind(tweakId).first();
  if (!tweak || tweak.uid !== uid) throw res({ error: 'Tweak not found.' }, 404);
  if (!tweak.resume_json) throw res({ error: 'Prune a resume for this tweak first, then publish it.' }, 409);

  const dup = await env.DB.prepare(`SELECT id FROM resume_pages WHERE slug = ?`).bind(slug).first();
  if (dup) throw res({ error: 'That link name is taken. Try another.' }, 409);

  const live = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM resume_pages WHERE uid = ? AND unpublished_at IS NULL`
  ).bind(uid).first();
  if ((live?.c || 0) >= MAX_LIVE_PAGES) throw res({ error: `You have ${MAX_LIVE_PAGES} live resume links already. Unpublish one first.` }, 409);

  const id = uuid();
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO resume_pages (id, uid, tweak_id, slug, indexable, view_count, published_at, style, accent, headline, links_json)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
  ).bind(id, uid, tweakId, slug, indexable, now, cfg.style, cfg.accent, cfg.headline, cfg.links_json).run();

  return res({ page: { id, tweak_id: tweakId, slug, indexable, view_count: 0, published_at: now, style: cfg.style, accent: cfg.accent, headline: cfg.headline, links: cfg.links } }, 201);
}

// GET /api/resume-pages
export async function resumePageList(request, env) {
  const uid = await requireAuth(request, env);
  const { results } = await env.DB.prepare(
    `SELECT id, tweak_id, slug, indexable, view_count, published_at, style, accent, headline, links_json
     FROM resume_pages WHERE uid = ? AND unpublished_at IS NULL
     ORDER BY published_at DESC`
  ).bind(uid).all();
  return res({ pages: (results || []).map(pageRow), max: MAX_LIVE_PAGES });
}

// PATCH /api/resume-pages/:id  — edit style/accent/headline/links in place
// (never slug or tweak), so a person can restyle without losing their link.
export async function resumePagePatch(request, env, pageId) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const uid = await requireAuth(request, env);
  const row = await env.DB.prepare(`SELECT uid, unpublished_at FROM resume_pages WHERE id = ?`).bind(pageId).first();
  if (!row || row.uid !== uid) throw res({ error: 'Page not found.' }, 404);
  if (row.unpublished_at != null) throw res({ error: 'That page is unpublished.' }, 409);

  const body = await readJson(request);
  const cfg = validateConfig(body, { partial: true });
  const sets = [];
  const binds = [];
  if ('style' in cfg)    { sets.push('style = ?');      binds.push(cfg.style); }
  if ('accent' in cfg)   { sets.push('accent = ?');     binds.push(cfg.accent); }
  if ('headline' in cfg) { sets.push('headline = ?');   binds.push(cfg.headline); }
  if ('links_json' in cfg) { sets.push('links_json = ?'); binds.push(cfg.links_json); }
  if (!sets.length) return res({ ok: true });
  binds.push(pageId);
  await env.DB.prepare(`UPDATE resume_pages SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return res({ ok: true });
}

// DELETE /api/resume-pages/:id — soft unpublish (link dies immediately).
export async function resumePageDelete(request, env, pageId) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const uid = await requireAuth(request, env);
  const row = await env.DB.prepare(`SELECT uid, unpublished_at FROM resume_pages WHERE id = ?`).bind(pageId).first();
  if (!row || row.uid !== uid) throw res({ error: 'Page not found.' }, 404);
  if (row.unpublished_at == null) {
    await env.DB.prepare(`UPDATE resume_pages SET unpublished_at = ? WHERE id = ?`).bind(nowSec(), pageId).run();
  }
  return res({ ok: true });
}

// Public GET /r/:slug — no auth. Server-rendered pretty resume.
export async function resumePagePublic(request, env, slug) {
  // Same hardening as every other HTML response from this worker; the miss
  // page used to ship with none of it.
  const notFound = () => new Response(renderNotFound(), {
    status: 404,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': publicCsp(),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store',
    },
  });

  if (!SLUG_RE.test(slug)) return notFound();

  const page = await env.DB.prepare(
    `SELECT rp.id, rp.indexable, rp.style, rp.accent, rp.headline, rp.links_json, t.resume_json
     FROM resume_pages rp JOIN tweaks t ON t.id = rp.tweak_id
     WHERE rp.slug = ? AND rp.unpublished_at IS NULL`
  ).bind(slug).first();

  if (!page || !page.resume_json) return notFound();

  let resumeObj;
  try { resumeObj = publicResume(JSON.parse(page.resume_json)); }
  catch { return notFound(); }
  if (!resumeObj) return notFound();

  const block = await rateLimit(request, env, `rpview:${page.id}`, 10, 60);
  if (!block) {
    try { await env.DB.prepare(`UPDATE resume_pages SET view_count = view_count + 1 WHERE id = ?`).bind(page.id).run(); }
    catch (e) { console.error('view count bump failed (non-fatal)', e.message || e); }
  }

  const cfg = {
    style: STYLES.has(page.style) ? page.style : 'modern',
    accent: ACCENT_RE.test(page.accent || '') ? page.accent : '#4f46e5',
    headline: page.headline || '',
    links: safeParseLinks(page.links_json).filter(l => l && l.label && safeUrl(l.url)),
  };

  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': publicCsp(),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': 'public, max-age=0, must-revalidate, no-cache',
  };
  if (!page.indexable) headers['X-Robots-Tag'] = 'noindex, nofollow';

  return new Response(renderPublicPage(resumeObj, cfg, !!page.indexable), { status: 200, headers });
}

// No inline executable script on the page — 'self' is enough. Styles come from
// the linked stylesheet plus one validated inline accent, so style-src allows
// 'unsafe-inline'.
function publicCsp() {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ') + ';';
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const a = parts[0][0] || '';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (a + b).toUpperCase();
}

// A small icon for a link, chosen by hostname; generic external-link fallback.
function linkIcon(url) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { /* keep generic */ }
  const G = { linkedin: '<path d="M4.98 3.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM3 9h4v12H3zM10 9h3.8v1.7h.05c.53-1 1.83-2.05 3.76-2.05 4.02 0 4.76 2.64 4.76 6.08V21H18.6v-5.4c0-1.29-.02-2.95-1.8-2.95-1.8 0-2.07 1.4-2.07 2.85V21H10z"/>' };
  if (host.includes('linkedin.')) return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${G.linkedin}</svg>`;
  if (host.includes('github.'))   return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 00-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 015 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0012 2z"/></svg>';
  if (host.includes('dribbble.')) return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 14c4-1 6-3 8-7M6 17c5 0 9-2 11-6"/></svg>';
  // generic external-link
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 3h7v7"/><path d="M21 3l-9 9"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>';
}

function renderPublicPage(r, cfg, indexable) {
  const name = r.name || 'Resume';
  const robotsMeta = indexable ? '' : '<meta name="robots" content="noindex, nofollow">';

  const contactBits = [];
  if (r.contact.email) contactBits.push(`<a href="mailto:${escHtml(r.contact.email)}">${escHtml(r.contact.email)}</a>`);
  if (r.contact.phone) contactBits.push(`<a href="tel:${escHtml(String(r.contact.phone).replace(/[^\d+]/g, ''))}">${escHtml(r.contact.phone)}</a>`);
  if (r.contact.location) contactBits.push(`<span>${escHtml(r.contact.location)}</span>`);
  const contact = contactBits.join('<span aria-hidden="true">·</span>');

  const links = cfg.links.map(l =>
    `<a class="link-btn" href="${escHtml(l.url)}" target="_blank" rel="noopener nofollow">${linkIcon(l.url)}${escHtml(l.label)}</a>`
  ).join('');

  const skills = r.skills.map(s => `<div class="skills-row"><b>${escHtml(s.category)}:</b> ${escHtml(s.items)}</div>`).join('');
  const experience = r.experience.map(j => `
    <div class="job">
      <div class="job-top">
        <div><span class="job-role">${escHtml(j.role || '')}</span>${j.company ? ` · <span class="job-co">${escHtml(j.company)}</span>` : ''}</div>
        ${j.dates ? `<span class="job-dates">${escHtml(j.dates)}</span>` : ''}
      </div>
      ${Array.isArray(j.bullets) && j.bullets.length ? `<ul>${j.bullets.map(b => `<li>${escHtml(b)}</li>`).join('')}</ul>` : ''}
    </div>`).join('');
  const education = r.education.map(e =>
    `<p class="edu-row">${escHtml(e.degree || '')}${e.school ? `, ${escHtml(e.school)}` : ''}${e.year ? ` (${escHtml(e.year)})` : ''}${e.detail ? ` · ${escHtml(e.detail)}` : ''}</p>`
  ).join('');
  const projects = r.projects.map(p => `
    <div class="proj">
      <div class="proj-name">${escHtml(p.name || '')}${p.tech ? ` · ${escHtml(p.tech)}` : ''}</div>
      ${p.summary ? `<div class="proj-summary">${escHtml(p.summary)}</div>` : ''}
    </div>`).join('');

  const dataAttrs = [`data-style="${escHtml(cfg.style)}"`, 'data-photo'];
  if (cfg.headline) dataAttrs.push('data-headline');
  if (cfg.links.length) dataAttrs.push('data-links');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(name)}, Resume</title>
${robotsMeta}
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=2">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/shared/hosted-resume.css">
</head>
<body>
<main class="stage">
  <article class="paper" ${dataAttrs.join(' ')} style="--accent:${escHtml(cfg.accent)}">
    <div class="rz">
      <header class="r-head">
        <div class="avatar" aria-hidden="true">${escHtml(initials(name))}</div>
        <div>
          <h1 class="r-name">${escHtml(name)}</h1>
          ${cfg.headline ? `<p class="r-headline">${escHtml(cfg.headline)}</p>` : ''}
          ${contact ? `<div class="r-contact">${contact}</div>` : ''}
        </div>
      </header>
      ${links ? `<nav class="links" aria-label="Links">${links}</nav>` : ''}
      <div class="r-body">
        ${r.summary ? `<section><h2 class="sec-title">Summary</h2><p style="margin:0;font-size:14.5px">${escHtml(r.summary)}</p></section>` : ''}
        ${experience ? `<section><h2 class="sec-title">Experience</h2>${experience}</section>` : ''}
        ${skills ? `<section><h2 class="sec-title">Skills</h2>${skills}</section>` : ''}
        ${education ? `<section><h2 class="sec-title">Education</h2>${education}</section>` : ''}
        ${projects ? `<section><h2 class="sec-title">Projects</h2>${projects}</section>` : ''}
      </div>
    </div>
  </article>
</main>
</body>
</html>`;
}

function renderNotFound() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Resume not found</title>
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=2">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; text-align: center;
         font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #EAF2EC;
         background: linear-gradient(135deg,#0F1714 0%,#101C17 100%); padding: 24px; }
  h1 { font-size: 1.5rem; margin: 0 0 8px; }
  a { color: #FFB547; font-weight: 700; }
</style>
</head>
<body>
<main>
  <h1>This resume link isn't live</h1>
  <p>It may have been unpublished or never existed.</p>
  <p><a href="/">Go to Resume Prune</a></p>
</main>
</body>
</html>`;
}
