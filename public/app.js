// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// /app dashboard logic.
// Auth + onboarding gate: bounce to /login if 401, /onboarding if no resume.
// Then enable: paste-JD → analyze → generate (resume/cover) → render via /shared/render.js → print.

const state = {
  profile: null,
  proStatus: null,
  currentTweakId: null,
  currentResumeJson: null,
  currentCoverJson: null,
  history: [],
  gapFills: [],
  gapJobs: [],
  pages: [],
  pagesMax: 5,
  pdfTemplate: 'classic',
};

// Pro/Sprint plans unlock the polished PDF template. Free stays 'classic' only.
// This gate is client-side by design: the server never sees PDF rendering
// (it happens in the browser via jsPDF), and the polished layout is cosmetic,
// not a data feature.
function isPaidPlan() {
  const p = state.proStatus?.plan;
  return p === 'pro' || p === 'sprint' || p === 'open';
}

function $(s) { return document.querySelector(s); }
// HTML-escape: covers &, <, >, ", ' so the result is safe in BOTH text content
// AND attribute values (single- or double-quoted). Don't narrow this without
// auditing every escText call site, some are inside `data-id="${escText(...)}"`.
function escText(s) { return String(s ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// User-facing copy for the two failures the app cannot explain any better.
// Raw fetch/TypeError messages ("Failed to fetch") never reach the screen.
const NET_ERR = "Can't reach the server. Check your connection and try again.";
const SERVER_ERR = 'Something went wrong on our end. Try again in a minute.';

async function api(path, opts = {}) {
  let r;
  try {
    r = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...opts });
  } catch (e) {
    throw new Error(NET_ERR);
  }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { window.location.replace('/login.html?next=/app.html'); throw new Error('unauthorized'); }
  if (!r.ok) {
    // The worker writes its own plain-language 4xx/502 messages. A bare 5xx
    // ("Server error", or no body at all) is the generic case.
    const own = typeof data.error === 'string' && data.error && data.error !== 'Server error';
    const err = new Error(own ? data.error : (r.status >= 500 ? SERVER_ERR : `Request failed (${r.status})`));
    err.code = typeof data.code === 'string' ? data.code : '';
    throw err;
  }
  return data;
}

async function bootGates() {
  const profile = await api('/api/profile');
  state.profile = profile;
  if (!profile.has_resume) { window.location.href = '/onboarding.html'; return false; }
  return true;
}

async function loadStatus() {
  state.proStatus = await api('/api/pro-status');
  renderTemplatePicker();
  const s = state.proStatus;
  const el = $('#usageStat');
  if (window.RPTwig) window.RPTwig.rank(document.getElementById('rankCard'), s.lifetime_tweaks);
  renderLimitCard(s);
  if (s.open) { // paid plans are off on this copy
    el.textContent = "No plan needed on this copy. Tweaks aren't limited.";
    return;
  }
  if (s.tweaks_limit === 0) {
    el.innerHTML = '<a href="/account" style="color:#FFB547;font-weight:700">Pick a plan</a> to start tweaking.';
    return;
  }
  const planName = s.plan === 'pro' ? 'Pro' : s.plan === 'sprint' ? 'Sprint' : 'Free';
  const period = s.plan === 'sprint' ? 'this week' : 'this month';
  // Gifted/comp testers have no Stripe subscription, make it explicit they're on
  // Pro for free so they never think they still need to pay.
  const gifted = !s.has_stripe;
  let planLabel;
  if (gifted) {
    let until = '';
    if (s.plan_expires) {
      try { until = ' through ' + new Date(s.plan_expires * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) {}
    }
    planLabel = `<strong style="color:#8FE0A8">${planName} ✓</strong> <span style="opacity:.8">(free testing access${until})</span>`;
  } else {
    planLabel = `<strong style="color:#FFB547">${planName} plan ✓</strong>`;
  }
  el.innerHTML = `${planLabel} &middot; ${s.tweaks_remaining} of ${s.tweaks_limit} tweaks left ${period}.`;
}

async function loadHistory() {
  const data = await api('/api/tweaks?limit=30');
  state.history = data.tweaks || [];
  state.monthAvg = data.month_avg ?? null;
  renderHistory();
}

// Job-hunt tracker states. Order matters: it's the pipeline.
const APP_STATUSES = [
  ['tweaked', 'Tweaked'],
  ['applied', 'Applied'],
  ['interviewing', 'Interviewing'],
  ['offer', 'Offer'],
  ['closed', 'Closed'],
];

function renderHistory() {
  const wrap = $('#history');
  renderHunt();
  renderMonthAvg();
  questTick();
  if (!$('#tipCard')?.hidden) renderTip(); // history count changed, so the tip pool may have too
  if (!state.history.length) {
    wrap.innerHTML = '<p class="muted small">Your tweaks will show up here.</p>';
    return;
  }
  wrap.innerHTML = state.history.map(t => {
    const date = new Date(t.created_at * 1000).toLocaleDateString('en-US', { month:'short', day:'numeric' });
    const role = t.role_title || 'Untitled role';
    const company = t.company_name ? ` · ${t.company_name}` : '';
    const active = t.id === state.currentTweakId ? 'active' : '';
    const status = t.app_status || 'tweaked';
    const options = APP_STATUSES.map(([v, label]) =>
      `<option value="${v}"${v === status ? ' selected' : ''}>${label}</option>`).join('');
    return `<div class="hist-item ${active}" data-id="${escText(t.id)}">
      <button class="hist-del" data-del="${escText(t.id)}" title="Delete this tweak" aria-label="Delete tweak">×</button>
      <strong>${escText(role)}</strong>${escText(company)}
      <small>${scoreChip(t)}${date}${t.has_resume ? ' · resume ✓' : ''}${t.has_cover ? ' · cover ✓' : ''}</small>
      <select class="hist-status st-${escText(status)}" data-status-for="${escText(t.id)}" aria-label="Application status for ${escText(role)}">${options}</select>${quietNote(t)}
    </div>`;
  }).join('');
  wrap.querySelectorAll('.hist-item').forEach(el => el.addEventListener('click', (e) => {
    if (e.target.closest('.hist-del') || e.target.closest('.hist-status') || e.target.closest('.hist-still')) return; // controls should not load the tweak
    loadTweak(el.dataset.id);
  }));
  wrap.querySelectorAll('.hist-status').forEach(sel => sel.addEventListener('change', async () => {
    const id = sel.dataset.statusFor;
    const value = sel.value;
    try {
      await api(`/api/tweaks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ app_status: value }),
      });
      const item = state.history.find(t => t.id === id);
      if (item) item.app_status = value;
      if (item) item.status_updated_at = Math.floor(Date.now() / 1000);
      renderHistory();
      if (value === 'interviewing' || value === 'offer') celebrate(value);
    } catch (err) {
      setFormError('Could not update status: ' + err.message);
      const item = state.history.find(t => t.id === id);
      sel.value = item?.app_status || 'tweaked';
    }
  }));
  wrap.querySelectorAll('.hist-del').forEach(btn => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const id = btn.dataset.del;
    const item = state.history.find(t => t.id === id);
    const label = item ? (item.role_title || 'this tweak') : 'this tweak';
    if (!confirm(`Delete ${label}? This can't be undone.`)) return;
    try {
      await api(`/api/tweaks/${encodeURIComponent(id)}`, { method: 'DELETE' });
      // If we just deleted the currently-loaded tweak, clear the form.
      if (state.currentTweakId === id) { clearTweakView(); setTweakUrl(null, true); }
      await loadHistory();
    } catch (err) {
      setFormError('Could not delete: ' + err.message);
    }
  }));
  wireQuiet(wrap);
}

// "Your hunt" vine: one node per in-flight application, oldest to newest.
// Leaf = applied, round bud = interviewing, fruit = offer. Pure SVG built from
// whitelisted status values and computed numbers only (no user text).
function renderHunt() {
  const el = $('#huntViz');
  if (!el) return;
  const items = state.history.filter(t => ['applied', 'interviewing', 'offer'].includes(t.app_status));
  if (!items.length) {
    if (!state.history.length) {
      // Brand-new dashboard: give the empty sidebar one real first step.
      el.innerHTML = '<p class="stat" style="margin:0 0 8px">Your hunt starts with your first match. Paste a job and see how your resume stacks up.</p>' +
        '<button type="button" class="ghost first-match-btn">Check your first match</button>';
      el.querySelector('.first-match-btn').addEventListener('click', () => tipAct('focusjd'));
      return;
    }
    el.innerHTML = '<p class="stat" style="margin:0">Mark a tweak as Applied and your hunt grows here.</p>';
    return;
  }
  const counts = { applied: 0, interviewing: 0, offer: 0 };
  items.forEach(t => { counts[t.app_status]++; });
  const shown = items.slice(0, 12).reverse(); // newest-first history -> oldest first on the vine
  const W = 240, H = 64;
  const colors = { applied: '#8FE0A8', interviewing: '#FFD36E', offer: '#FF9CC2' };
  const pos = (i) => {
    const x = 16 + (shown.length === 1 ? (W - 32) / 2 : i * ((W - 32) / (shown.length - 1)));
    const y = 32 + Math.sin(i * 1.1) * 10;
    return [x, y];
  };
  const stem = shown.map((t, i) => {
    const [x, y] = pos(i);
    return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  const nodes = shown.map((t, i) => {
    const [x, y] = pos(i);
    const c = colors[t.app_status];
    if (t.app_status === 'offer') {
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7.5" fill="${c}"/><circle cx="${x.toFixed(1)}" cy="${(y - 1.5).toFixed(1)}" r="2.5" fill="#0F1714"/>`;
    }
    if (t.app_status === 'interviewing') {
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5.5" fill="${c}"/>`;
    }
    return `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="7" ry="3.8" transform="rotate(-30 ${x.toFixed(1)} ${y.toFixed(1)})" fill="${c}" opacity="0.85"/>`;
  }).join('');
  const parts = [];
  if (counts.applied) parts.push(`${counts.applied} applied`);
  if (counts.interviewing) parts.push(`${counts.interviewing} interviewing`);
  if (counts.offer) parts.push(`${counts.offer} offer${counts.offer === 1 ? '' : 's'}`);
  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Job hunt progress: ${parts.join(', ')}">
      <path d="${stem}" fill="none" stroke="#8FA396" stroke-width="2" stroke-linecap="round" opacity="0.5"/>
      ${nodes}
    </svg>
    <p class="hunt-legend">${parts.join(' · ')}</p>`;
}

// Shown above the form when there is nothing left to spend: the reset date for a plan that ran
// out, or where the free tweaks live for an account with no plan (an account alone gets 0).
function renderLimitCard(s) {
  const box = $('#limitCard');
  if (!box) return;
  if (s.tweaks_limit > 0 && s.tweaks_remaining > 0) { box.hidden = true; box.innerHTML = ''; return; }
  if (s.tweaks_limit === 0) {
    box.innerHTML = `<h2>Tweaks come with a plan</h2>
      <p>An account on its own doesn't include tweaks. Your 2 free tweaks a month are on the <a href="/try">free plan</a> page, no login needed.</p>
      <p class="limit-actions"><a class="btn-primary" href="/account">Pick a plan</a> <a class="btn-secondary" href="/try">Use a free tweak</a></p>`;
  } else {
    const word = s.plan === 'sprint' ? 'this week' : 'this month';
    const more = s.plan === 'pro' && s.has_stripe ? ' Need more before then? Sprint gives you 20 a week.' : '';
    box.innerHTML = `<h2>You've used all ${s.tweaks_limit} tweaks ${word}</h2>
      <p>They come back on <strong>${nextResetLabel(s.plan)}</strong>.${more} Your past tweaks are all still here.</p>
      <p class="limit-actions"><a class="btn-primary" href="/account">See your plan</a></p>`;
  }
  box.hidden = false;
}

// Mirrors src/lib/usage.js: Sprint counts ISO weeks (Monday 00:00 UTC), everything else calendar months (UTC).
function nextResetLabel(plan) {
  const now = new Date();
  const d = plan === 'sprint'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 8 - (now.getUTCDay() || 7)))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// The open tweak lives in the URL (?t=), one history entry per tweak. Back steps through the tweaks
// you opened, and a round trip to /account (the Pro-template download) comes back to the same one.
function tweakInUrl() { return new URLSearchParams(location.search).get('t'); }
function setTweakUrl(id, replace) {
  if ((tweakInUrl() || null) === (id || null)) return;
  const u = new URL(location.href);
  if (id) u.searchParams.set('t', id); else u.searchParams.delete('t');
  try { history[replace ? 'replaceState' : 'pushState']({ [HIST_KEY]: 'app' }, '', u.pathname + u.search + u.hash); } catch (e) { /* ignore */ }
}
function clearTweakView() {
  state.currentTweakId = null;
  state.currentResumeJson = null;
  state.currentCoverJson = null;
  $('#jd').value = '';
  $('#roleTitle').value = '';
  $('#companyName').value = '';
  $('#analysisBox').style.display = 'none';
  $('#resume-preview').style.display = 'none';
  $('#cuts-preview').style.display = 'none';
  $('#cover-preview').style.display = 'none';
  renderHistory();
}

async function loadTweak(id, fromHistory) {
  try {
    const { tweak } = await api(`/api/tweaks/${encodeURIComponent(id)}`);
    state.currentTweakId = id;
    if (!fromHistory) setTweakUrl(id);
    state.currentRescores = tweak.rescores || 0;
    $('#jd').value = tweak.jd || '';
    $('#roleTitle').value = tweak.role_title || '';
    $('#companyName').value = tweak.company_name || '';
    renderAnalysis(tweak.analysis);
    resetPublishPanel();
    if (tweak.resume) {
      state.currentResumeJson = tweak.resume;
      window.RP.renderResume(tweak.resume, '#ats-doc');
      applyPreviewTemplate(state.pdfTemplate);
      $('#resume-preview').style.display = 'block';
      const cutsCount = window.RP.renderCuts(tweak.resume, '#cuts-out');
      $('#cuts-preview').style.display = cutsCount ? 'block' : 'none';
    } else {
      state.currentResumeJson = null;
      $('#resume-preview').style.display = 'none';
      $('#cuts-preview').style.display = 'none';
    }
    if (tweak.cover) {
      state.currentCoverJson = tweak.cover;
      window.RP.renderCover(tweak.cover, '#cover-doc');
      $('#cover-preview').style.display = 'block';
    } else {
      state.currentCoverJson = null;
      $('#cover-preview').style.display = 'none';
    }
    renderHistory();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    // A stale ?t= (deleted tweak, old link) opens the empty dashboard instead of an error.
    if (fromHistory) { clearTweakView(); setTweakUrl(null, true); return; }
    setFormError(e.message);
  }
}

function setFormError(msg) {
  const el = $('#formErr');
  el.textContent = msg || '';
  el.hidden = !msg;
}

async function onAnalyze() {
  setFormError('');
  const jd = $('#jd').value.trim();
  const roleTitle = $('#roleTitle').value.trim();
  const companyName = $('#companyName').value.trim();
  if (!roleTitle) { setFormError('Add the role title, it labels this tweak in your history.'); return; }
  if (jd.length < 50) { setFormError('Paste a longer job description (50+ chars).'); return; }

  $('#analyzeBtn').disabled = true;
  $('#analyzeBtn').textContent = 'Analyzing…';
  try {
    const data = await api('/api/tweak/analyze', {
      method: 'POST',
      body: JSON.stringify({ jobDescription: jd, roleTitle, companyName }),
    });
    const firstCheck = !(state.proStatus?.lifetime_tweaks > 0) && !state.history.length;
    state.currentTweakId = data.tweakId;
    state.currentRescores = 0;
    setTweakUrl(data.tweakId);
    renderAnalysis(data.analysis);
    if (window.RP.renderResumeChecks) window.RP.renderResumeChecks(data.resumeChecks, '#analysisOut');
    await Promise.all([loadStatus(), loadHistory()]);
    if (firstCheck) celebrate('firstCheck');
  } catch (e) {
    if (e.code === 'LIMIT_REACHED' || e.code === 'NO_PLAN') {
      await loadStatus().catch(() => {});
      const card = $('#limitCard');
      if (card && !card.hidden) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      else setFormError(e.message);
    } else {
      setFormError(e.message);
    }
  } finally {
    $('#analyzeBtn').disabled = false;
    $('#analyzeBtn').textContent = 'Check the match';
  }
}

function renderAnalysis(a) {
  if (!a) { $('#analysisBox').style.display = 'none'; return; }
  window.RP.renderAnalysis(a, '#analysisOut');
  decorateGaps();
  renderLowNote(a);
  $('#analysisBox').style.display = 'block';
}

// Score of 5 or under: two plain next steps (shared/render.js renderLowScoreNote).
function renderLowNote(a) {
  if (!window.RP.renderLowScoreNote) return;
  window.RP.renderLowScoreNote(a, '#analysisOut', {
    fillLabel: 'Show me the gaps',
    fillText: state.currentRescores
      ? 'Fill a gap below with what you actually did, then check the match again.'
      : 'Fill a gap below with what you actually did, then re-check. Your first re-check on this job is free.',
    skipLabel: 'Start a new job',
    onFill() {
      const out = $('#analysisOut');
      const head = [...out.querySelectorAll('h3')].find(h => h.textContent.trim() === 'Gaps');
      (head || out).scrollIntoView({ behavior: 'smooth', block: 'start' });
      const btn = head && head.nextElementSibling && head.nextElementSibling.querySelector('button');
      if (btn) btn.focus({ preventScroll: true });
    },
    onSkip() {
      clearTweakView();
      setTweakUrl(null);
      $('#roleTitle').scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('#roleTitle').focus({ preventScroll: true });
    },
  });
}

// ── Gap fills ───────────────────────────────────────────────────────────────
// Experience the user has but left off the base resume. Saved once, used by
// every future match check, prune, and cover letter server-side.

const GAPFILL_TRUNC = 90;

async function loadGapFills() {
  try {
    const data = await api('/api/gap-fills');
    state.gapFills = data.fills || [];
    state.gapJobs = data.jobs || [];
  } catch (e) { state.gapFills = []; state.gapJobs = []; }
  renderGapFillsSidebar();
}

// ---- Hosted resume links (Phase 6.2) ---------------------------------------

const PUB_SWATCHES = ['#4f46e5','#0e9488','#663399','#c02657','#c2701c','#2f6f4e','#475569','#0369a1'];
const MAX_PAGE_LINKS = 6;
// mode: 'create' publishes a new page from the loaded tweak; 'edit' PATCHes an
// existing page's look without touching its slug.
const pub = { mode: 'create', pageId: null };

async function loadPages() {
  try {
    const data = await api('/api/resume-pages');
    state.pages = data.pages || [];
    if (typeof data.max === 'number') state.pagesMax = data.max;
  } catch (e) { state.pages = []; }
  renderPagesSidebar();
}

function renderPagesSidebar() {
  questTick();
  const box = $('#pagesBox');
  if (!box) return;
  if (!state.pages.length) {
    box.innerHTML = '<p class="stat" style="margin:0">Prune a resume, then publish it as a shareable web page: your style, color, and links. Only the resume shows, never your analysis.</p>';
    return;
  }
  box.innerHTML = state.pages.map(pg => {
    const views = pg.view_count === 1 ? '1 view' : `${pg.view_count || 0} views`;
    const priv = pg.indexable ? '' : ' · private';
    return `<div class="page-item" data-id="${escText(pg.id)}">
      <div style="min-width:0">
        <p class="page-slug"><a href="/r/${escText(pg.slug)}" target="_blank" rel="noopener">/r/${escText(pg.slug)}</a></p>
        <p class="page-meta">${views}${priv} · <button type="button" class="page-edit" data-edit="${escText(pg.id)}">Edit look</button></p>
      </div>
      <button class="page-del" aria-label="Unpublish /r/${escText(pg.slug)}">&times;</button>
    </div>`;
  }).join('');
  box.querySelectorAll('.page-del').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.closest('.page-item').dataset.id;
    if (!confirm('Unpublish this resume link? The URL stops working right away.')) return;
    try { await api(`/api/resume-pages/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    catch (e) { alert(e.message); return; }
    state.pages = state.pages.filter(p => p.id !== id);
    renderPagesSidebar();
  }));
  box.querySelectorAll('.page-edit').forEach(btn => btn.addEventListener('click', () => {
    const pg = state.pages.find(p => p.id === btn.dataset.edit);
    if (pg) openPublishForEdit(pg);
  }));
}

function suggestSlug() {
  const name = state.currentResumeJson?.name || '';
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return base.length >= 3 ? base : '';
}

function setPublishErr(msg) {
  const el = $('#publishErr');
  el.textContent = msg || '';
  el.hidden = !msg;
}

// ---- panel field helpers ----
function setPubStyle(style) {
  $('#pubStyle').querySelectorAll('.tpl-opt').forEach(b => {
    const on = b.dataset.style === style;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}
function getPubStyle() {
  const b = $('#pubStyle').querySelector('.tpl-opt.is-active');
  return b ? b.dataset.style : 'modern';
}
function setPubAccent(hex) {
  $('#pubColor').value = hex;
  $('#pubSwatches').querySelectorAll('.swatch').forEach(s =>
    s.setAttribute('aria-pressed', s.dataset.hex === hex ? 'true' : 'false'));
}
function labelFromUrl(url) {
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url).hostname.replace(/^www\./, '');
    const known = { 'linkedin.com':'LinkedIn', 'github.com':'GitHub', 'dribbble.com':'Dribbble', 'behance.net':'Behance', 'medium.com':'Medium', 'x.com':'X', 'twitter.com':'X' };
    if (known[host]) return known[host];
    const base = host.split('.')[0] || 'Link';
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch (e) { return 'Link'; }
}
function makeLinkRow(label, url) {
  const row = document.createElement('div');
  row.className = 'pub-link-row';
  row.innerHTML = `<input class="pl-label" type="text" maxlength="40" placeholder="Label" aria-label="Link label">
    <input class="pl-url" type="text" maxlength="300" placeholder="linkedin.com/in/you" aria-label="Link URL">
    <button type="button" class="pub-link-del" aria-label="Remove link">&times;</button>`;
  row.querySelector('.pl-label').value = label || '';
  row.querySelector('.pl-url').value = url || '';
  row.querySelector('.pub-link-del').addEventListener('click', () => { row.remove(); updatePreview(); });
  return row;
}
function addPubLink(label, url) {
  const box = $('#pubLinks');
  if (box.querySelectorAll('.pub-link-row').length >= MAX_PAGE_LINKS) return;
  box.appendChild(makeLinkRow(label, url));
}
function clearPubLinks() { $('#pubLinks').innerHTML = ''; }
function collectPubLinks() {
  return [...$('#pubLinks').querySelectorAll('.pub-link-row')].map(r => ({
    label: r.querySelector('.pl-label').value.trim(),
    url: r.querySelector('.pl-url').value.trim(),
  })).filter(l => l.label || l.url);
}

// ---- live preview (renders the real hosted page in an isolated shadow root
// so its stylesheet can't collide with the dashboard) ----
let pubShadow = null;
function initPreviewHost() {
  const host = $('#pubPreview');
  if (!host || host.shadowRoot) return;
  pubShadow = host.attachShadow({ mode: 'open' });
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = '/shared/hosted-resume.css';
  const reset = document.createElement('style');
  reset.textContent = '.paper{margin:0}';
  const root = document.createElement('div');
  root.className = 'pv-root';
  pubShadow.append(link, reset, root);
}
function pvInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function pvLinkIcon(url) {
  let host = '';
  try { host = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) {}
  if (host.includes('linkedin.')) return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.98 3.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM3 9h4v12H3zM10 9h3.8v1.7h.05c.53-1 1.83-2.05 3.76-2.05 4.02 0 4.76 2.64 4.76 6.08V21H18.6v-5.4c0-1.29-.02-2.95-1.8-2.95-1.8 0-2.07 1.4-2.07 2.85V21H10z"/></svg>';
  if (host.includes('github.')) return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 00-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 015 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0012 2z"/></svg>';
  if (host.includes('dribbble.')) return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="10"/><path d="M8 14c4-1 6-3 8-7M6 17c5 0 9-2 11-6"/></svg>';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3h7v7"/><path d="M21 3l-9 9"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>';
}
// Mirrors the server's renderPublicPage() so the preview matches the real page.
function buildPreviewMarkup(r, cfg) {
  const c = r.contact || {};
  const contactBits = [];
  if (c.email) contactBits.push(`<a href="#">${escText(c.email)}</a>`);
  if (c.phone) contactBits.push(`<a href="#">${escText(c.phone)}</a>`);
  if (c.location) contactBits.push(`<span>${escText(c.location)}</span>`);
  const contact = contactBits.join('<span aria-hidden="true">·</span>');
  const links = cfg.links.filter(l => l.label).map(l =>
    `<a class="link-btn" href="#">${pvLinkIcon(l.url)}${escText(l.label)}</a>`).join('');
  const skills = (r.skills || []).map(s => `<div class="skills-row"><b>${escText(s.category)}:</b> ${escText(s.items)}</div>`).join('');
  const experience = (r.experience || []).map(j => `
    <div class="job"><div class="job-top">
      <div><span class="job-role">${escText(j.role || '')}</span>${j.company ? ` · <span class="job-co">${escText(j.company)}</span>` : ''}</div>
      ${j.dates ? `<span class="job-dates">${escText(j.dates)}</span>` : ''}
    </div>${Array.isArray(j.bullets) && j.bullets.length ? `<ul>${j.bullets.map(b => `<li>${escText(b)}</li>`).join('')}</ul>` : ''}</div>`).join('');
  const education = (r.education || []).map(e =>
    `<p class="edu-row">${escText(e.degree || '')}${e.school ? `, ${escText(e.school)}` : ''}${e.year ? ` (${escText(e.year)})` : ''}</p>`).join('');
  const attrs = [`data-style="${escText(cfg.style)}"`, 'data-photo'];
  if (cfg.headline) attrs.push('data-headline');
  if (links) attrs.push('data-links');
  return `<article class="paper" ${attrs.join(' ')} style="--accent:${escText(cfg.accent)}"><div class="rz">
    <header class="r-head"><div class="avatar" aria-hidden="true">${escText(pvInitials(r.name))}</div>
      <div><h1 class="r-name">${escText(r.name || '')}</h1>
        ${cfg.headline ? `<p class="r-headline">${escText(cfg.headline)}</p>` : ''}
        ${contact ? `<div class="r-contact">${contact}</div>` : ''}</div>
    </header>
    ${links ? `<nav class="links">${links}</nav>` : ''}
    <div class="r-body">
      ${r.summary ? `<section><h2 class="sec-title">Summary</h2><p style="margin:0;font-size:14.5px">${escText(r.summary)}</p></section>` : ''}
      ${experience ? `<section><h2 class="sec-title">Experience</h2>${experience}</section>` : ''}
      ${skills ? `<section><h2 class="sec-title">Skills</h2>${skills}</section>` : ''}
      ${education ? `<section><h2 class="sec-title">Education</h2>${education}</section>` : ''}
    </div>
  </div></article>`;
}
function currentPubConfig() {
  return {
    style: getPubStyle(),
    accent: $('#pubColor').value.toLowerCase(),
    headline: $('#pubHeadline').value.trim(),
    links: collectPubLinks(),
  };
}
function updatePreview() {
  if (!pubShadow || !state.currentResumeJson) return;
  const root = pubShadow.querySelector('.pv-root');
  if (root) root.innerHTML = buildPreviewMarkup(state.currentResumeJson, currentPubConfig());
}

function resetPublishPanel() {
  const panel = $('#publishPanel');
  if (!panel) return;
  panel.hidden = true;
  const res = $('#publishResult');
  if (res) { res.hidden = true; res.innerHTML = ''; }
  setPublishErr('');
}

function openPublishForCreate() {
  pub.mode = 'create'; pub.pageId = null;
  $('#publishSlugField').style.display = '';
  $('#publishIndexableField').style.display = '';
  $('#publishSlug').value = suggestSlug();
  $('#publishIndexable').checked = false;
  setPubStyle('modern');
  setPubAccent('#4f46e5');
  $('#pubHeadline').value = '';
  clearPubLinks();
  // Prefill link rows from any links already on the resume; else one empty row.
  const seed = (state.currentResumeJson?.contact?.links || []).filter(Boolean).slice(0, MAX_PAGE_LINKS);
  if (seed.length) seed.forEach(u => addPubLink(labelFromUrl(u), u));
  else addPubLink('', '');
  $('#publishResult').hidden = true;
  setPublishErr('');
  $('#publishBtn').textContent = 'Publish';
  $('#publishPanel').hidden = false;
  updatePreview();
  $('#publishSlug').focus();
}

async function openPublishForEdit(page) {
  // Editing restyles a live page in place — load its resume so the preview
  // matches, then bind the panel to that page id (slug can't change).
  if (page.tweak_id && page.tweak_id !== state.currentTweakId) {
    try { await loadTweak(page.tweak_id); } catch (e) { /* still allow editing look */ }
  }
  pub.mode = 'edit'; pub.pageId = page.id;
  $('#publishSlugField').style.display = 'none';
  $('#publishIndexableField').style.display = 'none';
  setPubStyle(page.style || 'modern');
  setPubAccent(/^#[0-9a-fA-F]{6}$/.test(page.accent || '') ? page.accent.toLowerCase() : '#4f46e5');
  $('#pubHeadline').value = page.headline || '';
  clearPubLinks();
  const links = Array.isArray(page.links) ? page.links : [];
  if (links.length) links.forEach(l => addPubLink(l.label, l.url));
  else addPubLink('', '');
  $('#publishResult').hidden = true;
  setPublishErr('');
  $('#publishBtn').textContent = 'Save changes';
  $('#publishPanel').hidden = false;
  updatePreview();
  $('#publishPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function submitPublish() {
  setPublishErr('');
  const config = {
    style: getPubStyle(),
    accent: $('#pubColor').value.toLowerCase(),
    headline: $('#pubHeadline').value.trim(),
    links: collectPubLinks(),
  };
  const btn = $('#publishBtn');
  const busyLabel = pub.mode === 'edit' ? 'Saving…' : 'Publishing…';
  const doneLabel = pub.mode === 'edit' ? 'Save changes' : 'Publish';
  btn.disabled = true; btn.textContent = busyLabel;
  try {
    if (pub.mode === 'edit') {
      await api(`/api/resume-pages/${encodeURIComponent(pub.pageId)}`, { method: 'PATCH', body: JSON.stringify(config) });
      const pg = state.pages.find(p => p.id === pub.pageId);
      if (pg) Object.assign(pg, config);
      renderPagesSidebar();
      const slug = pg ? pg.slug : '';
      const res = $('#publishResult');
      res.innerHTML = `Saved. <a href="/r/${escText(slug)}" target="_blank" rel="noopener">View your page</a>`;
      res.hidden = false;
    } else {
      const slug = $('#publishSlug').value.trim().toLowerCase();
      if (!/^[a-z0-9-]{3,40}$/.test(slug)) { setPublishErr('Link name must be 3–40 characters: lowercase letters, numbers, and hyphens only.'); return; }
      const data = await api('/api/resume-pages', {
        method: 'POST',
        body: JSON.stringify({ tweak_id: state.currentTweakId, slug, indexable: $('#publishIndexable').checked, ...config }),
      });
      state.pages.unshift(data.page);
      renderPagesSidebar();
      if (firstTime('pub')) celebrate('firstPublish');
      const url = `${location.origin}/r/${data.page.slug}`;
      const res = $('#publishResult');
      res.innerHTML = `Live at <a href="/r/${escText(data.page.slug)}" target="_blank" rel="noopener">${escText(url)}</a><button class="ghost" id="copyPageUrl" type="button">Copy</button>`;
      res.hidden = false;
      $('#copyPageUrl').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(url); $('#copyPageUrl').textContent = 'Copied'; }
        catch (e) { setPublishErr('Copy failed. Select the link and copy it manually.'); }
      });
    }
  } catch (e) {
    setPublishErr(e.message);
  } finally {
    btn.disabled = false; btn.textContent = doneLabel;
  }
}

function wirePublish() {
  const panel = $('#publishPanel');
  const btn = $('#publishResume');
  if (!panel || !btn) return;

  initPreviewHost();

  // Build accent swatches once.
  const sw = $('#pubSwatches');
  PUB_SWATCHES.forEach((hex, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'swatch'; b.dataset.hex = hex; b.style.background = hex;
    b.setAttribute('aria-label', 'Accent ' + hex);
    b.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
    b.addEventListener('click', () => { setPubAccent(hex); updatePreview(); });
    sw.appendChild(b);
  });
  $('#pubColor').addEventListener('input', e => { setPubAccent(e.target.value.toLowerCase()); updatePreview(); });
  $('#pubStyle').addEventListener('click', e => { const t = e.target.closest('.tpl-opt'); if (t) { setPubStyle(t.dataset.style); updatePreview(); } });
  $('#pubHeadline').addEventListener('input', updatePreview);
  $('#pubLinks').addEventListener('input', updatePreview);
  $('#pubAddLink').addEventListener('click', () => { addPubLink('', ''); updatePreview(); });

  btn.addEventListener('click', () => {
    if (!panel.hidden && pub.mode === 'create') { panel.hidden = true; return; }
    if (!state.currentTweakId || !state.currentResumeJson) {
      setFormError('Prune a resume first, then publish it to a link.');
      return;
    }
    openPublishForCreate();
  });
  $('#publishCancel').addEventListener('click', () => { panel.hidden = true; });
  $('#publishBtn').addEventListener('click', submitPublish);
}

function hasFillFor(gapText) {
  const norm = gapText.trim().toLowerCase();
  return state.gapFills.some(f => f.gap.trim().toLowerCase() === norm);
}

function renderGapFillsSidebar() {
  questTick();
  const box = $('#gapFillsBox');
  if (!box) return;
  if (!state.gapFills.length) {
    box.innerHTML = '<p class="stat" style="margin:0">Spot a gap you can actually fill in a match analysis? Save it once and every future check and resume can use it.</p>';
    return;
  }
  box.innerHTML = state.gapFills.map(f => `
    <div class="gapfill-item" data-id="${escText(f.id)}">
      <div>
        <p class="gapfill-gap">${escText(f.gap)}</p>
        ${f.job ? `<p class="gapfill-where">${escText(f.job)}</p>` : ''}
        <p class="gapfill-body">${escText(f.body.length > GAPFILL_TRUNC ? f.body.slice(0, GAPFILL_TRUNC) + '…' : f.body)}</p>
      </div>
      <button class="gapfill-del" aria-label="Delete saved experience: ${escText(f.gap)}">&times;</button>
    </div>`).join('');
  box.querySelectorAll('.gapfill-del').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.closest('.gapfill-item').dataset.id;
    if (!confirm('Delete this saved experience? Future match checks stop using it.')) return;
    try { await api(`/api/gap-fills/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    catch (e) { alert(e.message); return; }
    state.gapFills = state.gapFills.filter(f => f.id !== id);
    renderGapFillsSidebar();
  }));
}

// Add an "I can fill this gap" button to each rendered gap. The shared
// renderer (also used on /try) stays untouched; this decorates its output.
function decorateGaps() {
  const out = $('#analysisOut');
  if (!out) return;
  const gapsHead = [...out.querySelectorAll('h3')].find(h => h.textContent.trim() === 'Gaps');
  const ul = gapsHead ? gapsHead.nextElementSibling : null;
  if (!ul || ul.tagName !== 'UL') return;
  // The renderer's generic "add it to your resume" nudge is replaced by the
  // actual controls here.
  const nudge = ul.nextElementSibling;
  if (nudge && nudge.tagName === 'P') {
    nudge.textContent = 'Filled gaps are saved to your account. Every future match check, resume, and cover letter can use them.';
  }
  [...ul.children].forEach(li => {
    const gapText = li.textContent.trim();
    if (!gapText) return;
    if (hasFillFor(gapText)) {
      const tag = document.createElement('span');
      tag.className = 'gapfill-onfile';
      tag.textContent = 'On file';
      li.appendChild(tag);
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'gapfill-btn';
    btn.type = 'button';
    btn.textContent = 'I can fill this gap';
    btn.addEventListener('click', () => openGapFillForm(li, gapText, btn));
    li.appendChild(btn);
  });
}

const GAPFILL_ADD_JOB = '__add__';

function openGapFillForm(li, gapText, btn) {
  if (li.querySelector('.gapfill-form')) return;
  btn.style.display = 'none';
  const form = document.createElement('div');
  form.className = 'gapfill-form';
  const jobOptions = (state.gapJobs || [])
    .map(j => `<option value="${escText(j)}">${escText(j)}</option>`)
    .join('');
  form.innerHTML = `
    <label>Where did you do this?</label>
    <select class="gapfill-job">
      <option value="" selected disabled>Pick the job</option>
      ${jobOptions}
      <option value="${GAPFILL_ADD_JOB}">A job that isn't listed, add it</option>
    </select>
    <div class="gapfill-newjob" hidden>
      <div class="grid2" style="margin-top:6px">
        <div><label>Company</label><input type="text" class="gapfill-company" placeholder="e.g. Acme"></div>
        <div><label>Your role there</label><input type="text" class="gapfill-role" placeholder="e.g. Data Analyst"></div>
      </div>
      <label style="display:block;margin-top:6px">Dates (optional)</label>
      <input type="text" class="gapfill-dates" placeholder="e.g. 2021 to 2023">
    </div>
    <label style="display:block;margin-top:8px">What did you actually do?</label>
    <textarea placeholder="What you did there, in a sentence or two of real detail, like: Ran weekly SQL reports for the ops team, built the dashboards they replaced."></textarea>
    <div class="err" hidden></div>
    <div class="actions">
      <button type="button" class="gapfill-save">Save to my account</button>
      <button type="button" class="ghost gapfill-cancel">Cancel</button>
    </div>`;
  li.appendChild(form);
  const ta = form.querySelector('textarea');
  const err = form.querySelector('.err');
  const jobSel = form.querySelector('.gapfill-job');
  const newJobBox = form.querySelector('.gapfill-newjob');
  jobSel.addEventListener('change', () => {
    newJobBox.hidden = jobSel.value !== GAPFILL_ADD_JOB;
  });
  jobSel.focus();
  const showErr = (msg) => { err.textContent = msg; err.hidden = false; };
  form.querySelector('.gapfill-cancel').addEventListener('click', () => {
    form.remove();
    btn.style.display = '';
  });
  form.querySelector('.gapfill-save').addEventListener('click', async () => {
    const saveBtn = form.querySelector('.gapfill-save');
    err.hidden = true;
    let job = jobSel.value;
    if (!job) { showErr('Pick the job where you did this.'); return; }
    if (job === GAPFILL_ADD_JOB) {
      const company = form.querySelector('.gapfill-company').value.trim();
      const role = form.querySelector('.gapfill-role').value.trim();
      const dates = form.querySelector('.gapfill-dates').value.trim();
      if (!company || !role) { showErr('Add the company and your role there.'); return; }
      job = `${role} at ${company}${dates ? ` (${dates})` : ''}`;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const { fill } = await api('/api/gap-fills', {
        method: 'POST',
        body: JSON.stringify({ gap: gapText, job, body: ta.value }),
      });
      if (!state.gapJobs.includes(job)) state.gapJobs.push(job);
      state.gapFills.push(fill);
      renderGapFillsSidebar();
      form.remove();
      const tag = document.createElement('span');
      tag.className = 'gapfill-onfile';
      tag.textContent = 'On file';
      li.appendChild(tag);
      const hint = document.createElement('p');
      hint.className = 'gapfill-hint';
      hint.textContent = 'Saved. Re-check the match below to count it here, or it kicks in on your next check.';
      li.appendChild(hint);
      showRescoreBar();
      celebrate('gapFilled');
    } catch (e) {
      showErr(e.message);
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save to my account';
    }
  });
}

(async () => {
  if (!(await bootGates())) return;
  await Promise.all([loadStatus(), loadHistory(), loadGapFills(), loadPages()]);
  if (tweakInUrl()) await loadTweak(tweakInUrl(), true);
  questReady = true;
  questTick();
  $('#analyzeBtn').addEventListener('click', onAnalyze);
  wireGenerate();
  wirePublish();
  wireHelp();
  renderTip();
  maybeOfferTour();
  $('#logoutBtn').addEventListener('click', async (e) => {
    e.preventDefault();
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/';
  });
})();

async function onGenerate(mode) {
  if (!state.currentTweakId) {
    setFormError('Run "Check the match" first.');
    return;
  }
  const btn = mode === 'resume' ? $('#genResumeBtn') : $('#genCoverBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = mode === 'resume' ? 'Pruning your resume…' : 'Writing your cover letter…';
  try {
    const data = await api('/api/tweak/generate', {
      method: 'POST',
      body: JSON.stringify({ tweakId: state.currentTweakId, mode }),
    });
    if (mode === 'resume') {
      state.currentResumeJson = data.resume;
      resetPublishPanel();
      window.RP.renderResume(data.resume, '#ats-doc');
      applyPreviewTemplate(state.pdfTemplate);
      $('#resume-preview').style.display = 'block';
      const cutsCount = window.RP.renderCuts(data.resume, '#cuts-out');
      $('#cuts-preview').style.display = cutsCount ? 'block' : 'none';
    } else {
      state.currentCoverJson = data.cover;
      window.RP.renderCover(data.cover, '#cover-doc');
      $('#cover-preview').style.display = 'block';
    }
    await loadHistory(); // refresh has_resume/has_cover indicators
  } catch (e) {
    setFormError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function wireGenerate() {
  $('#genResumeBtn').addEventListener('click', () => onGenerate('resume'));
  $('#genCoverBtn').addEventListener('click', () => onGenerate('cover'));
  $('#printResume').addEventListener('click', async () => {
    if (!state.currentResumeJson) return;
    // Download gate: Modern/Executive are Pro. Free users can preview them but
    // downloading routes to pricing. Classic downloads for everyone.
    if (state.pdfTemplate !== 'classic' && !isPaidPlan()) {
      window.location.href = '/account';
      return;
    }
    const co = state.history.find(h => h.id === state.currentTweakId);
    const filename = window.RP.buildFilename({
      name: state.currentResumeJson.name,
      company: co?.company_name,
      role: co?.role_title,
      kind: 'resume',
    });
    await window.RP.downloadResumePdf(state.currentResumeJson, filename, state.pdfTemplate);
    if (firstTime('pdf')) { celebrate('firstPdf'); questTick(); }
  });
  wireTemplatePicker();
  $('#printCover').addEventListener('click', async () => {
    if (!state.currentCoverJson) return;
    const co = state.history.find(h => h.id === state.currentTweakId);
    const filename = window.RP.buildFilename({
      name: state.currentCoverJson.name || state.currentResumeJson?.name,
      company: co?.company_name,
      role: co?.role_title,
      kind: 'cover letter',
    });
    await window.RP.downloadCoverPdf(state.currentCoverJson, filename);
  });
}

// Segmented Classic/Polished picker. Polished is Pro-only; a free user who
// taps it is sent to pricing instead of switching. Pro badge only shows to
// free users (it reads as a lock, not a label, once you already have it).
function wireTemplatePicker() {
  const picker = $('#tplPicker');
  if (!picker) return;
  const opts = picker.querySelectorAll('.tpl-opt');
  opts.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tpl = btn.dataset.tpl;
      // Anyone can PREVIEW any style (it's just CSS over their own resume). The
      // Pro gate is on the download, not the preview, so a free user can see
      // exactly what they'd get before deciding to upgrade.
      state.pdfTemplate = tpl;
      opts.forEach((b) => {
        const on = b === btn;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      applyPreviewTemplate(tpl);
    });
  });
}

// Restyle the on-screen resume preview to match the selected PDF template.
// Pure CSS classes on #ats-doc (render.js stays untouched / snapshot-safe);
// Modern additionally groups the skills rows into a two-column block to mirror
// the PDF. Idempotent: safe to call after every re-render and on every click.
function applyPreviewTemplate(tpl) {
  const doc = $('#ats-doc');
  if (!doc) return;
  const t = tpl || 'classic';
  doc.classList.remove('tpl-classic', 'tpl-modern', 'tpl-executive');
  doc.classList.add('tpl-' + t);
  columnizeSkills(doc, t === 'modern');
}

// Wrap the contiguous .ats-skills-row divs in a column container (or unwrap).
// The rows are direct siblings in the render output; CSS multicol needs a
// parent, so we add/remove one here rather than editing the shared renderer.
function columnizeSkills(container, on) {
  container.querySelectorAll('.ats-skills-wrap').forEach((w) => {
    while (w.firstChild) w.parentNode.insertBefore(w.firstChild, w);
    w.remove();
  });
  if (!on) return;
  const rows = Array.from(container.querySelectorAll('.ats-skills-row'));
  if (rows.length < 2) return;
  const wrap = document.createElement('div');
  wrap.className = 'ats-skills-wrap';
  rows[0].parentNode.insertBefore(wrap, rows[0]);
  rows.forEach((r) => wrap.appendChild(r));
}

// Called after loadStatus so the Pro badges reflect the real plan. Hides the
// badges for paid users (they read as locks, not labels, once you have access);
// paid users can select any template freely.
function renderTemplatePicker() {
  const paid = isPaidPlan();
  document.querySelectorAll('#tplPicker .tpl-pro').forEach((b) => {
    b.style.display = paid ? 'none' : '';
  });
}


// =============================================================================
// Help system: the ? panel, the guided tour, and rotating tips.
// App help only. No promos, no links to anything sold, nothing to disclose.
// =============================================================================

// ---- overlay history -------------------------------------------------------
// ONE history entry per overlay (help OR tour, never one per tour stop). Back
// closes whatever is open and leaves the user on the dashboard. Help -> tour
// swaps the help entry for the tour's, so the pair still costs a single Back.
const HIST_KEY = 'rp';
try { history.replaceState({ [HIST_KEY]: 'app' }, ''); } catch (e) { /* ignore */ }
function overlayState() { return (history.state && history.state[HIST_KEY]) || null; }
function pushOverlay(kind) { try { history.pushState({ [HIST_KEY]: kind }, ''); } catch (e) { /* ignore */ } }
function replaceOverlay(kind) { try { history.replaceState({ [HIST_KEY]: kind }, ''); } catch (e) { /* ignore */ } }
// True when a Back press will finish the close (popstate does the teardown).
function closeOverlayViaHistory(kind) {
  if (overlayState() === kind) { history.back(); return true; }
  return false;
}
window.addEventListener('popstate', () => {
  const s = overlayState();
  // Nothing may stay open that doesn't match the entry we landed on. Forward
  // never reopens anything: a stale 'help'/'tour' entry with nothing open is
  // harmless, the next Back just steps over it.
  if (s !== 'help') closeHelp(true);
  if (s !== 'tour') endTour(true);
  const t = tweakInUrl();
  if ((t || null) !== (state.currentTweakId || null)) { if (t) loadTweak(t, true); else clearTweakView(); }
});

// ---- ? panel ---------------------------------------------------------------
let helpReturnFocus = null;
function helpOpen() { const ov = $('#helpOverlay'); return !!ov && !ov.hidden; }

function openHelp() {
  const ov = $('#helpOverlay');
  if (!ov || helpOpen()) return;
  if (tourActive()) { teardownTour(); replaceOverlay('help'); } // reuse the tour's entry
  else if (overlayState() !== 'help') pushOverlay('help');
  helpReturnFocus = document.activeElement;
  ov.hidden = false;
  document.body.style.overflow = 'hidden';
  $('#helpPanel').focus();
}

// fromHistory=true means popstate is already unwinding the entry: tear down
// directly, or calling history.back() again would loop.
function closeHelp(fromHistory) {
  if (!helpOpen()) return;
  if (!fromHistory && closeOverlayViaHistory('help')) return;
  $('#helpOverlay').hidden = true;
  document.body.style.overflow = '';
  if (helpReturnFocus && typeof helpReturnFocus.focus === 'function') helpReturnFocus.focus();
  helpReturnFocus = null;
}

function helpToTour() {
  const ov = $('#helpOverlay');
  ov.hidden = true;
  document.body.style.overflow = '';
  helpReturnFocus = null;
  if (overlayState() === 'help') replaceOverlay('tour'); else pushOverlay('tour');
  startTour(true);
}

function wireHelp() {
  const btn = $('#hdr-help');
  if (!btn) return;
  btn.addEventListener('click', openHelp);
  $('#helpX').addEventListener('click', () => closeHelp());
  $('#helpClose').addEventListener('click', () => closeHelp());
  $('#helpTour').addEventListener('click', helpToTour);
  $('#helpOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeHelp(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (helpOpen()) { e.preventDefault(); closeHelp(); }
      else if (tourActive()) { e.preventDefault(); endTour(); }
      return;
    }
    // Keep Tab inside the dialog while it's open.
    if (e.key === 'Tab' && helpOpen()) {
      const panel = $('#helpPanel');
      const f = [...panel.querySelectorAll('a[href], button:not([disabled])')];
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
}

// ---- guided tour -----------------------------------------------------------
// One box pinned to the bottom; each stop rings a real element. Selectors
// point at elements present in BOTH the empty and populated dashboard.
const TOUR_STOPS = [
  { sel: null, text: "New here? Let me show you around. Seven quick stops, or skip any time." },
  { sel: '#form', text: 'Start here. Paste a job posting, give it a role title, and hit Check the match. That spends one tweak.' },
  { sel: '#usageStat', text: 'Your tweak count lives here. Checking a match uses one. Pruning the resume and writing the cover letter from that match are included.' },
  { sel: '#gapFillsBox', text: "When the match analysis lists a gap you've actually done, tap I can fill this gap. It's saved here, and every future check uses it." },
  { sel: '#history', text: 'Every check lands here. Click one to bring it all back. The dropdown under each is your job tracker: Tweaked, Applied, Interviewing, Offer, Closed.' },
  { sel: '#huntViz', text: 'Mark a tweak Applied and a vine grows here. Leaf for applied, bud for interviewing, fruit for an offer.' },
  { sel: '#pagesBox', text: 'After you prune a resume, you can publish it as a web page at /r/your-name. Up to 5 live at once. Only the resume shows.' },
  { sel: '#hdr-help', text: "That's it. The ? brings this back any time, along with the full guide." },
];
const tour = { step: null, target: null };

function tourActive() { return tour.step !== null; }
function tourSeen() { try { return localStorage.getItem('rp_tour_done') === '1'; } catch (e) { return false; } }
function tourMarkSeen() { try { localStorage.setItem('rp_tour_done', '1'); } catch (e) { /* ignore */ } }

function startTour(entryReady) {
  teardownTour();
  if (!entryReady && overlayState() !== 'tour') pushOverlay('tour');
  tour.step = 0;
  renderTourStep();
}

function endTour(fromHistory) {
  if (!tourActive()) return;
  if (!fromHistory && closeOverlayViaHistory('tour')) return;
  teardownTour();
  tourMarkSeen();
}

function teardownTour() {
  tour.step = null;
  tour.target = null;
  document.getElementById('tourbox')?.remove();
  document.getElementById('tourring')?.remove();
}

function drawRing(el) {
  let ring = document.getElementById('tourring');
  if (!ring) { ring = document.createElement('div'); ring.id = 'tourring'; document.body.appendChild(ring); }
  const r = el.getBoundingClientRect();
  ring.style.left = (r.left - 6) + 'px';
  ring.style.top = (r.top - 6) + 'px';
  ring.style.width = (r.width + 12) + 'px';
  ring.style.height = (r.height + 12) + 'px';
}
function repositionRing() { if (tour.target && document.getElementById('tourring')) drawRing(tour.target); }
window.addEventListener('scroll', repositionRing, { passive: true });
window.addEventListener('resize', repositionRing);

function renderTourStep() {
  const n = tour.step;
  const stop = TOUR_STOPS[n];
  if (!stop) return endTour();
  document.getElementById('tourbox')?.remove();
  document.getElementById('tourring')?.remove();
  tour.target = null;

  if (stop.sel) {
    const el = document.querySelector(stop.sel);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      tour.target = el;
      drawRing(el);
    }
  }

  const last = n === TOUR_STOPS.length - 1;
  const box = document.createElement('div');
  box.id = 'tourbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'App tour');
  box.tabIndex = -1;
  box.innerHTML = `
    <p>${escText(stop.text)}</p>
    <div class="tourrow">
      <span class="tourcount">${n === 0 ? '' : `${n} of ${TOUR_STOPS.length - 1}`}</span>
      <button type="button" class="ghost" id="tour-skip">${last ? 'Done' : n === 0 ? 'No thanks' : 'Skip'}</button>
      ${last ? '' : `<button type="button" id="tour-next">${n === 0 ? 'Show me' : 'Next'}</button>`}
    </div>`;
  document.body.appendChild(box);
  $('#tour-skip').addEventListener('click', () => endTour());
  const next = $('#tour-next');
  if (next) next.addEventListener('click', () => { tour.step = n + 1; renderTourStep(); });
  (next || $('#tour-skip')).focus({ preventScroll: true });
}

// Offered automatically only to an account that has nothing yet AND can use
// the dashboard. An account with tweaks gets marked seen silently, no nag. An
// account with no plan isn't marked: the tour waits until it's useful.
function maybeOfferTour() {
  if (tourSeen()) return;
  if (state.history.length) { tourMarkSeen(); return; }
  if (!state.proStatus || !state.proStatus.tweaks_limit) return;
  startTour();
}

// ---- rotating tips ---------------------------------------------------------
// TIPS teach the app. They are NOT promos and never share a slot with one.
// No links, no labels, nothing to disclose. Rotates daily under This period.
const TIPS = [
  { text: 'Checking a match uses one tweak. Pruning the resume and writing the cover letter from that match are included.', cta: 'Start a tweak', act: 'focusjd' },
  { text: "A gap you've actually done? Tap I can fill this gap in the match analysis. Every future check uses it.", cta: 'See what’s on file', act: 'gofills' },
  { text: 'Mark a tweak Applied and it shows up on your hunt vine. Leaf, bud, fruit.', cta: 'Open past tweaks', act: 'gohistory' },
  { text: 'Read What got pruned and why before you send. Every cut is listed with the reason.', cta: 'How the prune works', act: 'help' },
  { text: 'Publish a pruned resume as a web page at /r/your-name. Only the resume shows, never the analysis.', cta: 'See live links', act: 'gopages' },
  { text: 'Changed jobs or fixed a typo? Edit resume at the top replaces your base. Past tweaks keep theirs.', cta: 'Edit my resume', act: 'editresume' },
  { text: 'Click any past tweak to bring the whole thing back: analysis, resume, cover letter.', cta: 'Open past tweaks', act: 'gohistory' },
];

function renderTip() {
  const card = $('#tipCard');
  if (!card || !TIPS.length) return;
  // No past tweaks yet: skip tips that point at an empty Past tweaks list.
  const pool = state.history.length ? TIPS : TIPS.filter(t => t.act !== 'gohistory');
  const tip = pool[Math.floor(Date.now() / 86400000) % pool.length];
  card.innerHTML = `<span class="tip-label">Tip</span><p class="tip-text">${escText(tip.text)}</p>` +
    `<button type="button" class="tip-cta">${escText(tip.cta)}</button>`;
  card.querySelector('.tip-cta').addEventListener('click', () => tipAct(tip.act));
  card.hidden = false;
}

function tipAct(act) {
  const go = (sel, focus) => { const el = $(sel); if (!el) return; el.scrollIntoView({ block: 'center', behavior: 'smooth' }); if (focus) el.focus({ preventScroll: true }); };
  switch (act) {
    case 'focusjd': go('#jd', true); break;
    case 'gofills': go('#gapFillsBox'); break;
    case 'gohistory': go('#history'); break;
    case 'gopages': go('#pagesBox'); break;
    case 'help': openHelp(); break;
    case 'editresume': window.location.href = '/onboarding.html'; break;
    default: break;
  }
}

// =============================================================================
// Round 2 (approved 2026-09-27): Twig celebrations, the first-week quest, score chips,
// the free first re-check after a gap fill, and the "gone quiet" nudge.
// Source: scripts/art/app-round2.js, appended to app.js by scripts/recolor-lantern.py.
// =============================================================================

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
// Per account, so a shared laptop never hands one person's milestones to another.
function flagKey(name) { return 'rp_' + name + '_' + (state.profile?.user?.id || 'me'); }

// ---- celebrations ------------------------------------------------------------
const CELEB = {
  firstCheck: { title: 'Your first match check', msg: "That's step one. Prune the resume next and I'll show you every cut and why.", score: 8, size: 'medium' },
  firstPdf: { title: 'First resume downloaded', msg: 'Fresh off the branch. Give it one last read before you send it. You always get the final say.', score: 9, size: 'medium' },
  firstPublish: { title: 'Your resume has its own link', msg: 'Put it in an application, an email, or your LinkedIn. You can take it down any time from Live resume links.', score: 9, size: 'medium' },
  gapFilled: { title: 'Gap filled', msg: 'Saved to your account. Every match check from here on counts it.', score: 7, size: 'small' },
  interviewing: { title: 'You got an interview!', msg: "Someone read it and wants to talk. That's what all the pruning was for.", score: 9, size: 'medium' },
  offer: { title: 'An offer!', msg: "Look at you. I'm blossoming over here.", score: 10, size: 'big' },
  questDone: { title: 'Quest complete', msg: "You've done the whole loop: check, fill, prune, download, publish, apply. From here it's reps.", score: 10, size: 'big' },
};
function celebrate(key, extra) {
  if (window.RPCelebrate && CELEB[key]) window.RPCelebrate.show(Object.assign({}, CELEB[key], extra || {}));
}
// One-time milestones (first PDF, first publish). Returns true the first time only.
function firstTime(name) {
  if (lsGet(flagKey(name))) return false;
  lsSet(flagKey(name), '1');
  return true;
}

// ---- first-week quest -----------------------------------------------------------
// Worked out from data the dashboard already loads, so it survives a new device. Only the PDF
// step lives in localStorage (downloads never touch the server).
const QUEST = [
  { label: 'Check your first match', done: () => state.history.length > 0 || (state.proStatus?.lifetime_tweaks || 0) > 0 },
  { label: 'Fill a gap you really have', done: () => state.gapFills.length > 0 },
  { label: 'Prune a resume', done: () => state.history.some(t => t.has_resume) },
  { label: 'Download it as a PDF', done: () => !!lsGet(flagKey('pdf')) },
  { label: 'Publish a resume link', done: () => state.pages.length > 0 || !!lsGet(flagKey('pub')) },
  { label: 'Mark one Applied', done: () => state.history.some(t => ['applied', 'interviewing', 'offer'].includes(t.app_status)) },
];
const QUEST_DAYS = 30; // older accounts never see a "first-week" quest
let questReady = false; // false until the first full load, so a half-loaded page never "completes" it

function questHidden() {
  if (lsGet(flagKey('questdone')) || lsGet(flagKey('questhide'))) return true;
  const made = Number(state.profile?.user?.created_at) || 0;
  return made > 0 && Date.now() / 1000 - made > QUEST_DAYS * 86400;
}

function questTick() {
  const box = $('#questCard');
  if (!box || !questReady) return;
  if (questHidden()) { box.hidden = true; return; }
  const steps = QUEST.map(q => ({ label: q.label, done: !!q.done() }));
  const n = steps.filter(s => s.done).length;
  if (n === steps.length) {
    lsSet(flagKey('questdone'), '1');
    box.hidden = true;
    if (questTick.seenOpen) celebrate('questDone'); // finished in front of them, not already done on load
    return;
  }
  questTick.seenOpen = true;
  box.innerHTML = `
    <div class="quest-head"><span class="rank-label">First-week quest</span><b>${n} of ${steps.length}</b></div>
    <span class="rank-bar" role="progressbar" aria-label="First-week quest progress" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${n}"><i style="width:${Math.round(n / steps.length * 100)}%"></i></span>
    <ol class="quest-list">${steps.map(s => `<li class="${s.done ? 'done' : ''}"><span class="quest-tick" aria-hidden="true">${s.done ? '&#10003;' : ''}</span>${escText(s.label)}${s.done ? '<span class="sr-only"> (done)</span>' : ''}</li>`).join('')}</ol>
    <button type="button" class="quest-hide">Hide the quest</button>`;
  box.querySelector('.quest-hide').addEventListener('click', () => { lsSet(flagKey('questhide'), '1'); box.hidden = true; });
  box.hidden = false;
}

// ---- score chips + monthly average ------------------------------------------
function scoreChip(t) {
  if (t.score == null || !isFinite(t.score)) return '';
  const s = Math.max(0, Math.min(10, Math.round(Number(t.score))));
  return `<span class="hist-score" aria-label="Match score ${s} out of 10">${s}/10</span>`;
}
function renderMonthAvg() {
  const el = $('#histAvg');
  if (!el) return;
  if (state.monthAvg == null) { el.hidden = true; return; }
  el.textContent = `avg ${state.monthAvg} this month`;
  el.hidden = false;
}

// ---- the "gone quiet" nudge --------------------------------------------------
const QUIET_DAYS = 14;
function quietNote(t) {
  if (!['applied', 'interviewing'].includes(t.app_status) || !t.status_updated_at) return '';
  const days = Math.floor((Date.now() / 1000 - t.status_updated_at) / 86400);
  if (days < QUIET_DAYS) return '';
  return `<div class="hist-quiet">No news in ${days} days. A short follow-up note is fair game.
    <button type="button" class="hist-still" data-still="${escText(t.id)}">Still waiting</button></div>`;
}
// "Still waiting" re-saves the same status, which restarts the clock server-side.
function wireQuiet(wrap) {
  wrap.querySelectorAll('.hist-still').forEach(btn => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const item = state.history.find(t => t.id === btn.dataset.still);
    if (!item) return;
    btn.disabled = true;
    try {
      const d = await api(`/api/tweaks/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ app_status: item.app_status }) });
      item.status_updated_at = d.status_updated_at || Math.floor(Date.now() / 1000);
      renderHistory();
    } catch (err) {
      btn.disabled = false;
      setFormError('Could not update status: ' + err.message);
    }
  }));
}

// ---- free first re-check after a gap fill ---------------------------------------
function showRescoreBar() {
  const out = $('#analysisOut');
  if (!out || !state.currentTweakId || $('#rescoreBar')) return;
  const free = !state.currentRescores;
  const bar = document.createElement('div');
  bar.className = 'rescore-bar';
  bar.id = 'rescoreBar';
  bar.innerHTML = `<p>You added experience. Re-check this match to count it.</p>
    <button type="button" id="rescoreBtn">Re-check the match</button>
    <small>${free ? 'Your first re-check on this job is free.' : 'Uses 1 tweak. The free re-check on this job is used.'}</small>
    <div class="err" hidden></div>`;
  out.appendChild(bar);
  $('#rescoreBtn').addEventListener('click', onRescore);
}

async function onRescore() {
  const btn = $('#rescoreBtn');
  const err = $('#rescoreBar .err');
  const before = state.history.find(t => t.id === state.currentTweakId)?.score;
  btn.disabled = true; btn.textContent = 'Re-checking…'; err.hidden = true;
  try {
    const data = await api(`/api/tweaks/${encodeURIComponent(state.currentTweakId)}/rescore`, { method: 'POST', body: '{}' });
    state.currentRescores = (state.currentRescores || 0) + 1;
    renderAnalysis(data.analysis); // redraws #analysisOut, so the bar goes with it
    await Promise.all([loadStatus(), loadHistory()]);
    const after = Number(data.analysis?.match_score ?? data.analysis?.score);
    if (before != null && isFinite(after) && after > before) {
      celebrate('gapFilled', { title: `Score went from ${before} to ${after}`, msg: 'That gap fill just paid off. Prune the resume and it comes along too.', score: after });
    }
  } catch (e) {
    if (e.code === 'LIMIT_REACHED' || e.code === 'NO_PLAN') {
      await loadStatus().catch(() => {});
      $('#limitCard')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if ($('#rescoreBtn')) {
      btn.disabled = false; btn.textContent = 'Re-check the match';
      err.textContent = e.message; err.hidden = false;
    }
  }
}
