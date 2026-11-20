// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Shared render functions for resume + cover JSON.
// Used by index.html (live results) and sample.html (revisit-from-email).

(function () {
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Many resumes put the name banner in ALL CAPS. That's fine for a resume header
  // but reads as shouting under "Sincerely,". Only normalize if the entire string
  // is already uppercase, so natural names like "McDonald" or "van der Berg"
  // are left alone.
  function fixNameCase(s) {
    if (!s || typeof s !== 'string') return s;
    if (s !== s.toUpperCase()) return s;
    return s.split(/\s+/)
      .map(w => w.length === 0 ? w : w[0] + w.slice(1).toLowerCase())
      .join(' ');
  }

  function renderResume(r, target) {
    if (typeof target === 'string') target = document.querySelector(target);
    if (!target) return;
    if (!r) { target.innerHTML = ''; return; }
    const contact = [r.contact && r.contact.email, r.contact && r.contact.phone, r.contact && r.contact.location]
      .filter(Boolean).map(esc).join(' &middot; ');
    const links = ((r.contact && r.contact.links) || []).filter(Boolean)
      .map(u => (/^\s*(https?:\/\/|mailto:)/i.test(u) || !/^[^/?#]*:/.test(String(u).replace(/[\s\x00-\x1f]/g, ''))) // no javascript: and friends
        ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`
        : esc(u)).join(' &middot; ');
    const skills = (r.skills || []).map(s =>
      `<div class="ats-skills-row"><strong>${esc(s.category)}:</strong> ${esc(s.items)}</div>`
    ).join('');
    const experience = (r.experience || []).map(j => `
      <div class="ats-job">
        <div class="ats-job-line">
          <span>${esc(j.company)}${j.location ? ', ' + esc(j.location) : ''}</span>
          <span class="ats-job-dates">${esc(j.dates || '')}</span>
        </div>
        <div class="ats-job-role">${esc(j.role || '')}</div>
        <ul class="ats-bullets">${(j.bullets || []).map(b => `<li>${esc(b)}</li>`).join('')}</ul>
      </div>`).join('');
    const education = (r.education || []).map(e =>
      `<p style="margin:2px 0;font-size:10.5pt">${esc(e.degree)}${e.school ? ', ' + esc(e.school) : ''}${e.year ? ' (' + esc(e.year) + ')' : ''}${e.detail ? ' &middot; ' + esc(e.detail) : ''}</p>`
    ).join('');
    const projects = (r.projects || []).map(p => `
      <div class="ats-project">
        <div class="ats-project-line">${esc(p.name)}${p.tech ? ' <span class="ats-project-tech" style="display:inline">&middot; ' + esc(p.tech) + '</span>' : ''}</div>
        <div style="font-size:10.5pt;line-height:1.5">${esc(p.summary || '')}</div>
      </div>`).join('');

    target.innerHTML = `
      <h1>${esc(r.name || '')}</h1>
      ${r.title_line ? `<div class="ats-title-line">${esc(r.title_line)}</div>` : ''}
      <div class="ats-contact">${contact}</div>
      ${links ? `<div class="ats-links">${links}</div>` : ''}
      <hr class="ats-divider">
      ${r.summary ? `<h2>Professional Summary</h2><p class="ats-summary">${esc(r.summary)}</p>` : ''}
      ${skills ? `<h2>Skills</h2>${skills}` : ''}
      ${experience ? `<h2>Experience</h2>${experience}` : ''}
      ${education ? `<h2>Education</h2>${education}` : ''}
      ${projects ? `<h2>Projects</h2>${projects}` : ''}
    `;
  }

  function renderCover(c, target) {
    if (typeof target === 'string') target = document.querySelector(target);
    if (!target) return;
    if (!c) { target.innerHTML = ''; return; }
    const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const contact = [c.contact && c.contact.email, c.contact && c.contact.phone, c.contact && c.contact.location]
      .filter(Boolean).map(esc).join(' &middot; ');
    const paragraphs = (c.paragraphs || []).map(p => `<p>${esc(p)}</p>`).join('');
    const displayName = fixNameCase(c.name || '');
    target.innerHTML = `
      <div class="cover-header">
        <div class="cover-name">${esc(displayName)}</div>
        <div class="cover-contact">${contact}</div>
      </div>
      <div class="cover-date">${esc(today)}</div>
      <div class="cover-greeting">${esc(c.greeting || 'Dear Hiring Manager,')}</div>
      <div class="cover-body">${paragraphs}</div>
      <div class="cover-signoff">${esc(c.signoff || 'Sincerely,')}<br>${esc(displayName)}</div>
    `;
  }

  // Circular match-score gauge. Color bands: 8+ sage (strong), 5-7 gold
  // (workable), under 5 coral (stretch). Pure SVG so it prints and screenshots
  // cleanly — this is the shareable artifact of the analysis.
  function gaugeSvg(score) {
    const s = Math.max(0, Math.min(10, Number(score)));
    // One amber-to-pink gradient at every score (the old 5-7 gold was 2.9:1 on cream).
    const color = 'url(#' + (gaugeSvg.n = (gaugeSvg.n || 0) + 1, 'rpgauge' + gaugeSvg.n) + ')';
    const gid = 'rpgauge' + gaugeSvg.n;
    const C = 2 * Math.PI * 34;
    const arc = (s / 10) * C;
    return `<svg viewBox="0 0 84 84" width="96" height="96" role="img" aria-label="Match score ${s} out of 10" style="flex:none">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFB547"/><stop offset="1" stop-color="#FF9CC2"/></linearGradient></defs>
      <circle cx="42" cy="42" r="34" fill="none" stroke="var(--rule,#2B3B32)" stroke-width="9"/>
      <circle cx="42" cy="42" r="34" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round"
        stroke-dasharray="${arc.toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 42 42)"/>
      <text x="42" y="46" text-anchor="middle" font-size="24" font-weight="700" fill="${color}" font-family="Figtree,system-ui,sans-serif">${s}</text>
      <text x="42" y="60" text-anchor="middle" font-size="9" font-weight="700" fill="var(--ink-3,#A7B8AD)" font-family="Figtree,system-ui,sans-serif">of 10</text>
    </svg>`;
  }

  // Match-analysis renderer. Used by try.html (free flow) and app.js (/app dashboard)
  // so both surfaces share the exact same visual treatment of score / alignments / gaps.
  function renderAnalysis(a, target) {
    if (typeof target === 'string') target = document.querySelector(target);
    if (!target) return;
    if (!a) { target.innerHTML = ''; return; }
    const score = a.match_score ?? a.score;
    const hasScore = Number.isFinite(Number(score));
    const headStyle = 'font-size:1.15rem;margin:1.25rem 0 0.5rem;font-weight:700;font-family:var(--font-head)';
    const listStyle = 'margin:0;padding-left:1.4em;line-height:1.55';
    const scoreBlock = hasScore
      ? `<div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
           ${gaugeSvg(score)}
           <div style="flex:1;min-width:200px">
             <p style="font-size:1rem;margin:0"><strong style="color:var(--plum,#FFB547)">Match score</strong></p>
             ${a.match_notes ? `<p style="margin:0.35rem 0 0;line-height:1.55">${esc(a.match_notes)}</p>` : ''}
           </div>
         </div>`
      : `<p style="font-size:1rem;margin:0"><strong style="color:var(--plum,#FFB547)">Match score:</strong> ?/10</p>
         ${a.match_notes ? `<p style="margin:0.5rem 0 0;line-height:1.55">${esc(a.match_notes)}</p>` : ''}`;
    target.innerHTML = `
      ${scoreBlock}
      ${Array.isArray(a.key_alignments) && a.key_alignments.length
        ? `<h3 style="${headStyle};color:var(--sage,#8FE0A8)">Strong alignments</h3><ul style="${listStyle}">${a.key_alignments.map(m => `<li style="margin-bottom:0.3em">${esc(m)}</li>`).join('')}</ul>`
        : ''}
      ${Array.isArray(a.potential_gaps) && a.potential_gaps.length
        ? `<h3 style="${headStyle};color:var(--coral,#FF9AA4)">Gaps</h3><ul style="${listStyle}">${a.potential_gaps.map(m => `<li style="margin-bottom:0.3em">${esc(m)}</li>`).join('')}</ul>
           <p style="margin:0.65rem 0 0;font-style:italic;color:#A7B8AD;font-size:0.92rem;line-height:1.5">Have you actually done any of these but didn't put them on your resume? Add them and check the match again. Resume Prune can only work with what's on the page.</p>`
        : ''}
    `;
    if (hasScore && typeof CustomEvent === 'function' && typeof document.dispatchEvent === 'function') document.dispatchEvent(new CustomEvent('rp:score', { detail: { score: Number(score) } }));
  }

  // Low-match note (2026-10-16). A score of 5 or under is the scariest screen in the app, so it
  // gets two plain next steps: fill a gap you've really done, or skip the job. Called by the
  // dashboard and the free try page AFTER renderAnalysis, so renderAnalysis's output (and its
  // snapshot test) is unchanged. opts: { onFill, onSkip, fillLabel, fillText, skipLabel }.
  const LOW_MATCH_MAX = 5;
  function renderLowScoreNote(a, target, opts) {
    if (typeof target === 'string') target = document.querySelector(target);
    if (!target || !a || !opts) return null;
    const raw = Number(a.match_score ?? a.score);
    if (!Number.isFinite(raw)) return null;
    const s = Math.max(0, Math.min(10, Math.round(raw)));
    if (s > LOW_MATCH_MAX) return null;
    const note = document.createElement('div');
    note.className = 'low-note';
    note.setAttribute('role', 'note');
    note.innerHTML = `
      <p class="low-note-head">Low match. Here's what to do with it.</p>
      <p class="low-note-lead">A ${s} means this posting asks for things your resume doesn't show yet. Pick the one that's true:</p>
      <div class="low-note-paths">
        <div class="low-note-path">
          <b>I've done some of these</b>
          <span>${esc(opts.fillText)}</span>
          <button type="button" class="low-note-btn" data-low="fill">${esc(opts.fillLabel)}</button>
        </div>
        <div class="low-note-path">
          <b>This one's not for me</b>
          <span>Skip it. You've spent one check, and that's all. Paste the next posting.</span>
          <button type="button" class="low-note-btn ghost" data-low="skip">${esc(opts.skipLabel)}</button>
        </div>
      </div>`;
    const first = target.firstElementChild;
    if (first && first.insertAdjacentElement) first.insertAdjacentElement('afterend', note);
    else target.appendChild(note);
    note.querySelector('[data-low="fill"]').addEventListener('click', () => opts.onFill && opts.onFill());
    note.querySelector('[data-low="skip"]').addEventListener('click', () => opts.onSkip && opts.onSkip());
    return note;
  }

  // Quick resume cleanups (2026-11-02). Rule-based suggestions from src/lib/resume-checks.js:
  // year counts, long summaries, old roles, a separate achievements section, and filler to cut.
  // Suggestions only, never edits. APPENDS to target (after the analysis, gaps and low-match
  // note) so renderAnalysis's output and its snapshot test stay unchanged. Replaces any earlier
  // copy in the same target, so a re-render never stacks two. Returns the count shown.
  function renderResumeChecks(items, target) {
    if (typeof target === 'string') target = document.querySelector(target);
    if (!target) return 0;
    const old = target.querySelector('.rp-cleanups');
    if (old) old.remove();
    const list = Array.isArray(items) ? items.filter(i => i && typeof i.label === 'string' && i.label.trim()) : [];
    if (!list.length) return 0;
    const box = document.createElement('div');
    box.className = 'rp-cleanups';
    box.innerHTML = `
      <h3 style="font-size:1.15rem;margin:1.25rem 0 0.35rem;font-weight:700;font-family:var(--font-head);color:var(--plum,#FFB547)">Quick resume cleanups</h3>
      <p style="margin:0 0 0.6rem;color:var(--ink-2,#C9D6CD);font-size:0.92rem;line-height:1.5">Suggestions only. Nothing on your resume changes unless you edit it.</p>
      <ul style="margin:0;padding-left:1.4em;line-height:1.55">
        ${list.map(i => `<li style="margin-bottom:0.45em"><strong>${esc(i.label)}</strong><br><span style="color:var(--ink-2,#C9D6CD);font-size:0.94rem">${esc(i.note || '')}</span></li>`).join('')}
      </ul>`;
    target.appendChild(box);
    return list.length;
  }

  // "What got pruned and why" — renders resume.pruning_notes (the prune stage's
  // transparency report). Returns the number of entries rendered so callers can
  // show/hide the surrounding card. Every field is esc()'d; model output is
  // untrusted input like everything else.
  function renderCuts(r, target) {
    if (typeof target === 'string') target = document.querySelector(target);
    if (!target) return 0;
    const notes = (r && Array.isArray(r.pruning_notes))
      ? r.pruning_notes.filter(n => n && typeof n.cut === 'string' && n.cut.trim())
      : [];
    if (!notes.length) { target.innerHTML = ''; return 0; }
    target.innerHTML = `
      <p style="margin:0 0 0.75rem;line-height:1.55;color:var(--ink-2,#C9D6CD)">These didn't make the cut for this job. Nothing is lost, and if you disagree with one, add it back before you send.</p>
      ${notes.map(n => `
        <div style="padding:0.65rem 0;border-bottom:1px solid var(--rule,#2B3B32)">
          <span style="text-decoration:line-through;text-decoration-thickness:1.5px;color:#C79AA2">${esc(n.cut)}</span>
          ${n.where ? ` <span style="font-size:0.78rem;font-weight:700;color:var(--ink-3,#A7B8AD);white-space:nowrap">${esc(n.where)}</span>` : ''}
          ${n.reason ? `<div style="font-size:0.88rem;color:var(--ink-2,#C9D6CD);margin-top:0.15rem">${esc(n.reason)}</div>` : ''}
        </div>`).join('')}
    `;
    return notes.length;
  }

  // Bulletproof print: physically move the active doc-preview to a print-stage
  // div that's a direct body child, hide every other body child via display:none,
  // print, then restore the original DOM position. This avoids the
  // visibility:hidden trap (layout space → blank extra pages) and works on every
  // page regardless of how deeply nested the doc-preview is.
  function printDoc(which) {
    const docId = which === 'resume' ? 'resume-preview' : 'cover-preview';
    const doc = document.getElementById(docId);
    if (!doc) return;
    if (document.getElementById('print-stage')) return; // already printing

    const origParent = doc.parentNode;
    const origNext = doc.nextSibling;

    const stage = document.createElement('div');
    stage.id = 'print-stage';
    stage.appendChild(doc);
    document.body.appendChild(stage);
    document.body.classList.add('printing-' + which);

    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      document.body.classList.remove('printing-resume', 'printing-cover');
      if (origNext) origParent.insertBefore(doc, origNext);
      else origParent.appendChild(doc);
      stage.remove();
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    // Safety net: restore after 30s even if afterprint never fires (some browsers).
    setTimeout(restore, 30000);

    setTimeout(() => window.print(), 50);
  }

  window.RP = window.RP || {};
  window.RP.esc = esc;
  window.RP.renderResume = renderResume;
  window.RP.renderCover = renderCover;
  window.RP.renderAnalysis = renderAnalysis;
  window.RP.renderLowScoreNote = renderLowScoreNote;
  window.RP.renderCuts = renderCuts;
  window.RP.renderResumeChecks = renderResumeChecks;
  window.RP.printDoc = printDoc;
  window.printDoc = printDoc; // legacy global for inline onclick
})();
