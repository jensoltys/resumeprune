// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Onboarding wizard state machine
// Step 1: pick a file or paste text → produce { rawText, sourceFilename }
// Step 2: POST /api/profile/upload-resume → { parsed, suggestEdits, rawTextEcho }
// Step 3: edit parsed → PUT /api/profile/resume
// Step 4: PUT /api/profile target_role/target_industry → redirect to /app
//
// Auth: page bounces to /login if /api/profile returns 401.

import * as pdfjs from '/vendor/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';

const state = {
  step: 1,
  rawText: '',
  sourceFilename: null,
  parsed: null,
  suggestEdits: [],
  resumeChecks: [],
};

function $(sel) { return document.querySelector(sel); }
const NET_ERR = "Can't reach the server. Check your connection and try again.";
const SERVER_ERR = 'Something went wrong on our end. Try again in a minute.';
// A thrown fetch error is a TypeError; anything else carries our own message.
function humanError(e, fallback) { return e instanceof TypeError ? NET_ERR : (e && e.message) || fallback; }
// Every wizard step is in-page state, so each one gets a history entry: Back
// returns to the previous step instead of leaving the page. Step 2 (parsing) is
// transient, so the step that follows it replaces its entry and Back from step 3
// lands on step 1. fromHistory=true means popstate is restoring a step: render
// only, never touch history.
const HIST_KEY = 'rpStep';
function show(step, fromHistory) {
  if (!fromHistory) {
    try {
      const cur = history.state && history.state[HIST_KEY];
      const next = Object.assign({}, history.state || {}, { [HIST_KEY]: step });
      if (cur == null || cur === 2) history.replaceState(next, '');
      else if (cur !== step) history.pushState(next, '');
    } catch (e) { /* ignore */ }
  }
  state.step = step;
  document.querySelectorAll('section[data-step]').forEach(s => {
    s.hidden = (Number(s.dataset.step) !== step);
  });
  document.querySelectorAll('.progress .dot').forEach(d => {
    const n = Number(d.dataset.step);
    d.classList.toggle('done', n < step);
    d.classList.toggle('cur',  n === step);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
window.addEventListener('popstate', (e) => {
  const s = e.state && e.state[HIST_KEY];
  if (s == null || s === state.step) return;
  // Steps 3 and 4 need a parsed resume in memory; the parse screen is never a
  // landing spot. Anything else falls back to the upload step.
  const ok = s === 1 || ((s === 3 || s === 4) && state.parsed);
  show(ok ? s : 1, true);
});

// ── Auth gate ────────────────────────────────────────────────
async function requireSession() {
  let r;
  try {
    r = await fetch('/api/profile', { credentials: 'include' });
  } catch (e) {
    throw new Error(NET_ERR);
  }
  if (r.status === 401) { window.location.replace('/login.html?next=/onboarding.html'); return null; }
  if (!r.ok) {
    throw new Error(SERVER_ERR);
  }
  return r.json();
}

// ── Step 1, Upload / Paste ──────────────────────────────────
function setStep1Error(msg) {
  const el = $('#step1Err');
  el.textContent = msg || '';
  el.hidden = !msg;
  $('#step1Next').disabled = !!msg || !state.rawText;
  if (msg) setFileStatus('', null); // an error replaces the selected-file note
}

// Visible confirmation that a file was picked. On mobile the only old signal was
// the Continue button changing color, which is easy to miss, show the filename.
function setFileStatus(msg, kind) {
  const el = $('#fileStatus');
  const drop = $('#fileDrop');
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
  el.className = 'file-status' + (kind ? ' ' + kind : '');
  if (drop) drop.classList.toggle('has-file', kind === 'ready');
}

function clearStep1() {
  state.rawText = '';
  state.sourceFilename = null;
  setStep1Error('');
  setFileStatus('', null);
  $('#step1Next').disabled = true;
}

function looksLikeResume(text) {
  return text && text.trim().length >= 50;
}

async function readPdfFile(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const text = await page.getTextContent();
    const lines = [];
    let lastY = null;
    for (const item of text.items) {
      if (lastY !== null && Math.abs(item.transform[5] - lastY) > 2) lines.push('\n');
      lines.push(item.str + ' ');
      lastY = item.transform[5];
    }
    out.push(lines.join(''));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function readDocxFile(file) {
  // Mammoth ships as a UMD global on window when loaded as a classic script.
  // We load it lazily because the bundle is ~1.5MB.
  if (!window.mammoth) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/mammoth.browser.min.js';
      s.onload = resolve; s.onerror = () => reject(new Error('mammoth load failed'));
      document.head.appendChild(s);
    });
  }
  const buf = await file.arrayBuffer();
  const result = await window.mammoth.extractRawText({ arrayBuffer: buf });
  return (result.value || '').trim();
}

async function handleFile(file) {
  clearStep1();
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { setStep1Error('File is over 5 MB. Try compressing or paste the text instead.'); return; }
  const name = (file.name || 'resume').toLowerCase();
  // Instant feedback the moment they pick a file, reading a PDF can take a few
  // seconds on a phone, and they need to know something is happening.
  setFileStatus('Reading ' + file.name + '…', 'reading');
  try {
    let text;
    if (name.endsWith('.pdf'))  text = await readPdfFile(file);
    else if (name.endsWith('.docx')) text = await readDocxFile(file);
    else { setStep1Error('Unsupported file type. PDF or DOCX only.'); return; }
    if (!looksLikeResume(text)) { setStep1Error("We couldn't pull readable text from that file. Try pasting the text instead."); return; }
    state.rawText = text;
    state.sourceFilename = file.name;
    setFileStatus('✓ ' + file.name + ' added. Tap Continue.', 'ready');
    $('#step1Next').disabled = false;
    $('#step1Err').hidden = true;
  } catch (e) {
    console.error(e);
    setStep1Error('Failed to read the file. Try pasting the text instead.');
  }
}

function wireStep1() {
  const drop = $('#fileDrop');
  const input = $('#fileInput');
  input.addEventListener('change', e => handleFile(e.target.files?.[0]));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('drag');
    handleFile(e.dataTransfer.files?.[0]);
  });
  $('#pasteToggle').addEventListener('click', e => { e.preventDefault(); $('#pasteWrap').hidden = false; });
  $('#pasteArea').addEventListener('input', e => {
    const v = e.target.value.trim();
    if (looksLikeResume(v)) {
      state.rawText = v;
      state.sourceFilename = null;
      $('#step1Next').disabled = false;
      $('#step1Err').hidden = true;
    } else {
      $('#step1Next').disabled = true;
    }
  });
  $('#step1Next').addEventListener('click', () => { goToStep2(); });
}

// ── Step 2, Server Parse ────────────────────────────────────
async function goToStep2() {
  show(2);
  $('#step2Err').hidden = true;
  $('#step2Status').textContent = 'Extracting structure from your resume…';

  try {
    const r = await fetch('/api/profile/upload-resume', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rawText: state.rawText,
        sourceFilename: state.sourceFilename,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      $('#step2Err').textContent = data.error || 'Could not extract resume.';
      $('#step2Err').hidden = false;
      $('#step2Status').textContent = r.status === 429
        ? 'Your resume text is still here, so nothing is lost.'
        : 'You can go back and try a cleaner copy/paste.';
      // Add a back button dynamically.
      if (!document.getElementById('step2Back')) {
        const back = document.createElement('button');
        back.id = 'step2Back';
        back.className = 'ghost';
        back.textContent = 'Back to upload';
        back.style.marginTop = '14px';
        back.addEventListener('click', () => show(1));
        document.querySelector('section[data-step="2"]').appendChild(back);
      }
      return;
    }
    state.parsed = data.parsed;
    state.suggestEdits = data.suggestEdits || [];
    state.resumeChecks = data.resumeChecks || [];
    if (data.rawTextEcho && !state.rawText) state.rawText = data.rawTextEcho;
    renderReview();
    show(3);
  } catch (e) {
    console.error(e);
    $('#step2Err').textContent = NET_ERR;
    $('#step2Err').hidden = false;
  }
}

// ── Step 3, Review + Edit + Save ───────────────────────────
function escAttr(s) { return String(s ?? '').replace(/"/g, '&quot;'); }
function escText(s) { return String(s ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function renderReview() {
  const p = state.parsed || {};
  const sug = state.suggestEdits || [];
  $('#suggestList').innerHTML = sug.length
    ? '<strong>Heads up:</strong> ' + sug.map(escText).join(' · ')
    : '';
  if (window.RP && window.RP.renderResumeChecks) window.RP.renderResumeChecks(state.resumeChecks, '#cleanupList');

  const skills = Array.isArray(p.skills) ? p.skills : [];
  const exp = Array.isArray(p.experience) ? p.experience : [];
  const edu = Array.isArray(p.education) ? p.education : [];

  const html = `
    <div>
      <label>Name</label>
      <input type="text" id="rv_name" value="${escAttr(p.name || '')}">
    </div>
    <div>
      <label>Title line (e.g. "Senior Software Engineer · NYC")</label>
      <input type="text" id="rv_title_line" value="${escAttr(p.title_line || '')}">
    </div>
    <div class="job-row">
      <div><label>Email</label><input type="email" id="rv_email" value="${escAttr(p.contact?.email || '')}"></div>
      <div><label>Phone</label><input type="text" id="rv_phone" value="${escAttr(p.contact?.phone || '')}"></div>
    </div>
    <div class="job-row">
      <div><label>Location</label><input type="text" id="rv_location" value="${escAttr(p.contact?.location || '')}"></div>
      <div><label>Links (comma-sep)</label><input type="text" id="rv_links" value="${escAttr((p.contact?.links || []).join(', '))}"></div>
    </div>
    <div>
      <label>Summary</label>
      <textarea id="rv_summary" style="min-height:80px">${escText(p.summary || '')}</textarea>
    </div>

    <div>
      <label>Skills (one category per line, format "Category: items")</label>
      <textarea id="rv_skills" style="min-height:90px">${escText(skills.map(s => `${s.category || ''}: ${s.items || ''}`).join('\n'))}</textarea>
    </div>

    <div>
      <label>Experience</label>
      <div id="rv_exp"></div>
      <button class="ghost small" id="rv_add_job" type="button" style="padding:6px 14px;font-size:13px">+ Add job</button>
    </div>

    <div>
      <label>Education (one per line, "Degree, School, Year, Detail")</label>
      <textarea id="rv_education" style="min-height:80px">${escText(edu.map(e => [e.degree, e.school, e.year, e.detail].filter(Boolean).join(', ')).join('\n'))}</textarea>
    </div>
  `;
  $('#reviewForm').innerHTML = html;
  renderJobs(exp);
  $('#rv_add_job').addEventListener('click', () => {
    const cur = readJobs();
    cur.push({ company:'', role:'', dates:'', location:'', bullets:[''] });
    renderJobs(cur);
  });
}

function renderJobs(jobs) {
  const wrap = $('#rv_exp');
  wrap.innerHTML = jobs.map((j, i) => `
    <div class="job-card" data-job="${i}">
      <div class="job-row">
        <div><label>Company</label><input type="text" data-f="company" value="${escAttr(j.company || '')}"></div>
        <div><label>Role</label><input type="text" data-f="role" value="${escAttr(j.role || '')}"></div>
      </div>
      <div class="job-row">
        <div><label>Dates</label><input type="text" data-f="dates" value="${escAttr(j.dates || '')}"></div>
        <div><label>Location</label><input type="text" data-f="location" value="${escAttr(j.location || '')}"></div>
      </div>
      <label style="margin-top:8px">Bullets</label>
      <div class="bullet-list">
        ${(j.bullets || ['']).map(b => `
          <div class="bullet-row">
            <input type="text" data-f="bullet" value="${escAttr(b)}">
            <button class="rmBullet" type="button">×</button>
          </div>
        `).join('')}
      </div>
      <button class="ghost small addBullet" type="button" style="padding:6px 14px;font-size:13px">+ Bullet</button>
      <button class="ghost small rmJob" type="button" style="padding:6px 14px;font-size:13px;color:#FF9AA4;border-color:#34463B;margin-left:6px">Remove job</button>
    </div>
  `).join('');
  wrap.querySelectorAll('.addBullet').forEach(btn => btn.addEventListener('click', e => {
    const card = e.target.closest('.job-card');
    const list = card.querySelector('.bullet-list');
    const row = document.createElement('div');
    row.className = 'bullet-row';
    row.innerHTML = '<input type="text" data-f="bullet" value=""><button class="rmBullet" type="button">×</button>';
    list.appendChild(row);
    row.querySelector('.rmBullet').addEventListener('click', () => row.remove());
  }));
  wrap.querySelectorAll('.rmBullet').forEach(btn => btn.addEventListener('click', e => e.target.closest('.bullet-row').remove()));
  wrap.querySelectorAll('.rmJob').forEach(btn => btn.addEventListener('click', e => e.target.closest('.job-card').remove()));
}

function readJobs() {
  return [...document.querySelectorAll('#rv_exp .job-card')].map(card => {
    const get = f => card.querySelector(`input[data-f="${f}"]`)?.value.trim() || '';
    const bullets = [...card.querySelectorAll('input[data-f="bullet"]')].map(i => i.value.trim()).filter(Boolean);
    return { company: get('company'), role: get('role'), dates: get('dates'), location: get('location'), bullets };
  });
}

function readReview() {
  const skillsLines = $('#rv_skills').value.split('\n').map(l => l.trim()).filter(Boolean);
  const skills = skillsLines.map(l => {
    const [cat, ...rest] = l.split(':');
    return { category: (cat || '').trim(), items: rest.join(':').trim() };
  });
  const eduLines = $('#rv_education').value.split('\n').map(l => l.trim()).filter(Boolean);
  const education = eduLines.map(l => {
    const [degree, school, year, ...rest] = l.split(',').map(s => s.trim());
    return { degree: degree || '', school: school || '', year: year || '', detail: rest.join(', ') };
  });
  return {
    name: $('#rv_name').value.trim(),
    title_line: $('#rv_title_line').value.trim() || null,
    contact: {
      email: $('#rv_email').value.trim() || null,
      phone: $('#rv_phone').value.trim() || null,
      location: $('#rv_location').value.trim() || null,
      links: $('#rv_links').value.split(',').map(s => s.trim()).filter(Boolean),
    },
    summary: $('#rv_summary').value.trim() || null,
    skills: skills.filter(s => s.category || s.items),
    experience: readJobs(),
    education,
  };
}

async function saveReview() {
  $('#step3Err').hidden = true;
  const parsed = readReview();
  if (!parsed.name) {
    $('#step3Err').textContent = 'Please add a name.';
    $('#step3Err').hidden = false;
    return;
  }
  $('#step3Next').disabled = true;
  try {
    const r = await fetch('/api/profile/resume', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parsedJson: parsed, rawText: state.rawText, sourceFilename: state.sourceFilename }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Save failed');
    state.parsed = parsed;
    show(4);
  } catch (e) {
    $('#step3Err').textContent = humanError(e, 'Save failed.');
    $('#step3Err').hidden = false;
  } finally {
    $('#step3Next').disabled = false;
  }
}

// ── Step 4, Target Capture + Redirect ──────────────────────
async function finishOnboarding(skip) {
  $('#step4Err').hidden = true;
  $('#step4Done').disabled = true;
  $('#step4Skip').disabled = true;
  try {
    if (!skip) {
      const target_role = $('#targetRole').value.trim();
      const target_industry = $('#targetIndustry').value.trim();
      if (target_role || target_industry) {
        const r = await fetch('/api/profile', {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target_role,
            target_industry,
            newsletter_consent: !!state.profile?.user?.newsletter_consent,
          }),
        });
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          throw new Error(data.error || 'Could not save target preferences.');
        }
      }
    }
    window.location.href = '/app.html';
  } catch (e) {
    $('#step4Err').textContent = humanError(e, 'Could not save target preferences.');
    $('#step4Err').hidden = false;
    $('#step4Done').disabled = false;
    $('#step4Skip').disabled = false;
  }
}

// ── Boot ─────────────────────────────────────────────────────
(async () => {
  try {
    const profile = await requireSession();
    if (!profile) return;
    state.profile = profile;
    wireStep1();
    document.getElementById('step3Back').addEventListener('click', () => show(1));
    document.getElementById('step3Next').addEventListener('click', saveReview);
    document.getElementById('step4Done').addEventListener('click', () => finishOnboarding(false));
    document.getElementById('step4Skip').addEventListener('click', () => finishOnboarding(true));

    // Edit mode (?edit=1 from the account page): load the EXISTING saved resume
    // straight into the review editor so the name/contact/experience can be fixed
    // in place, no re-upload. Falls back to the upload flow if there's no resume.
    const editMode = new URLSearchParams(location.search).get('edit') === '1';
    if (editMode && profile.has_resume && profile.resume?.parsed) {
      state.parsed = profile.resume.parsed;
      state.rawText = profile.resume.raw || '';
      state.sourceFilename = profile.resume_meta?.source_filename || null;
      state.suggestEdits = [];
      state.resumeChecks = [];
      // Reframe the page from "set up" to "edit".
      const brand = document.querySelector('.brand'); if (brand) brand.textContent = 'Edit your resume';
      const intro = document.querySelector('.container > .muted'); if (intro) intro.textContent = 'Fix anything that is wrong, your name, contact details, experience. Every future tweak pulls from this.';
      const tr = document.getElementById('targetRole'); if (tr) tr.value = profile.user?.target_role || '';
      const ti = document.getElementById('targetIndustry'); if (ti) ti.value = profile.user?.target_industry || '';
      renderReview();
      show(3);
    } else {
      show(1);
    }
  } catch (e) {
    console.error('[onboarding boot]', e);
    const detail = humanError(e, 'Please try again.');
    document.querySelector('.container').innerHTML =
      '<p class="err">Something went wrong loading the wizard.</p>' +
      '<p class="muted small" style="white-space:pre-wrap">' + detail.replace(/[<&>]/g, c => ({'<':'&lt;','&':'&amp;','>':'&gt;'}[c])) + '</p>' +
      '<p><a href="/login.html?next=/onboarding.html">Sign in</a> · <a href="/">Back to home</a></p>';
  }
})();
