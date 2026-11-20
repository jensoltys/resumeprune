// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Client-side PDF generation for resume + cover. Emits real text (not images)
// via jsPDF so the output stays ATS-friendly. No browser print headers,
// no URL footer, no "allow print" popup, just a downloadable PDF.
//
// Usage:
//   await window.RP.downloadResumePdf(resumeJson, 'jane-doe-acme.pdf')
//   await window.RP.downloadCoverPdf(coverJson, 'jane-doe-cover.pdf')
//
// Loads jsPDF lazily on first call so the ~410KB bundle isn't paid for
// on initial page load.

(function () {
  let jspdfLoaded = null;

  function loadJsPdf() {
    if (jspdfLoaded) return jspdfLoaded;
    jspdfLoaded = new Promise((resolve, reject) => {
      if (window.jspdf && window.jspdf.jsPDF) return resolve(window.jspdf.jsPDF);
      const s = document.createElement('script');
      s.src = '/vendor/jspdf.umd.min.js';
      s.onload = () => {
        if (window.jspdf && window.jspdf.jsPDF) resolve(window.jspdf.jsPDF);
        else reject(new Error('jsPDF loaded but window.jspdf.jsPDF not found'));
      };
      s.onerror = () => reject(new Error('Failed to load jsPDF'));
      document.head.appendChild(s);
    });
    return jspdfLoaded;
  }

  // Layout constants in points (jsPDF unit). Letter = 612 × 792 pt.
  // Margins follow modern ATS-friendly resume convention:
  //   - Top/bottom: 0.5" (36pt), denser top-of-page, more content visible above the fold
  //   - Left/right: 0.6" (43pt), comfortable line length without cramping
  // Source: Harvard career services + Indeed 2024 resume guide + Resume Worded.
  const PAGE = { w: 612, h: 792, mTop: 36, mBot: 36, mLeft: 43, mRight: 43 };
  const CONTENT_W = PAGE.w - PAGE.mLeft - PAGE.mRight;

  // Slugify a name for the download filename.
  function slug(s) {
    return String(s || 'resume').trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'resume';
  }

  // Wrap a text block to the content width and emit it. Returns the new y.
  function emitText(doc, text, y, opts) {
    const o = Object.assign({ size: 10.5, style: 'normal', leading: 1.4, color: [0, 0, 0], indent: 0 }, opts || {});
    doc.setFont('helvetica', o.style);
    doc.setFontSize(o.size);
    doc.setTextColor(o.color[0], o.color[1], o.color[2]);
    const maxW = CONTENT_W - o.indent;
    const lines = doc.splitTextToSize(String(text || ''), maxW);
    const lineHeight = o.size * o.leading;
    for (const line of lines) {
      y = pageBreakIfNeeded(doc, y, lineHeight);
      doc.text(line, PAGE.mLeft + o.indent, y);
      y += lineHeight;
    }
    return y;
  }

  function pageBreakIfNeeded(doc, y, neededHeight) {
    if (y + neededHeight > PAGE.h - PAGE.mBot) {
      doc.addPage();
      return PAGE.mTop;
    }
    return y;
  }

  function drawHr(doc, y) {
    doc.setDrawColor(120, 120, 120);
    doc.setLineWidth(0.5);
    doc.line(PAGE.mLeft, y, PAGE.w - PAGE.mRight, y);
    return y + 6;
  }

  // Reserve `nextItemHeight` so the header doesn't orphan at the bottom of a
  // page with its first item starting on the next page. ~50pt is a safe
  // estimate for a name+contact line or a short bullet.
  function sectionHeader(doc, label, y, nextItemHeight = 50) {
    y = pageBreakIfNeeded(doc, y, 22 + nextItemHeight);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(0, 0, 0);
    doc.text(label.toUpperCase(), PAGE.mLeft, y);
    y += 4;
    drawHr(doc, y);
    return y + 10;
  }

  // Normalize ALL-CAPS names to title case for cover signoffs.
  function fixNameCase(s) {
    if (!s || typeof s !== 'string') return s;
    if (s !== s.toUpperCase()) return s;
    return s.split(/\s+/).map(w => w.length === 0 ? w : w[0] + w.slice(1).toLowerCase()).join(' ');
  }

  function buildResumePdf(jsPDF, r) {
    const doc = new jsPDF({ unit: 'pt', format: 'letter', compress: true });
    if (typeof doc.setLanguage === 'function') doc.setLanguage('en-US');
    doc.setProperties({
      title: `${r.name || 'Resume'}, Resume`,
      author: r.name || '',
      subject: 'Resume',
      creator: 'Resume Prune',
    });
    let y = PAGE.mTop + 22; // baseline for first text line at 22pt cap-height

    // Header, name centered visually as the dominant element
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.setTextColor(0, 0, 0);
    doc.text(String(r.name || ''), PAGE.mLeft, y);
    y += 22;

    if (r.title_line) {
      y = emitText(doc, r.title_line, y, { size: 11.5, style: 'bold', leading: 1.25, color: [50, 50, 50] });
    }

    // Contact line: email · phone · location (clickable email)
    const contactBits = [r.contact?.email, r.contact?.phone, r.contact?.location].filter(Boolean);
    if (contactBits.length) {
      const line = contactBits.join('  ·  ');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10.5);
      doc.setTextColor(50, 50, 50);
      doc.text(line, PAGE.mLeft, y);
      // Hyperlink the email portion if present
      if (r.contact?.email) {
        const emailW = doc.getTextWidth(r.contact.email);
        doc.link(PAGE.mLeft, y - 9, emailW, 12, { url: 'mailto:' + r.contact.email });
      }
      y += 14;
    }

    // Links line: clickable URLs
    const links = (r.contact?.links || []).filter(Boolean);
    if (links.length) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(50, 50, 50);
      let x = PAGE.mLeft;
      links.forEach((u, i) => {
        if (i > 0) {
          doc.text('  ·  ', x, y);
          x += doc.getTextWidth('  ·  ');
        }
        const w = doc.getTextWidth(u);
        doc.text(u, x, y);
        if (/^https?:\/\//i.test(u) || /^www\./i.test(u)) {
          const url = /^https?:\/\//i.test(u) ? u : 'https://' + u;
          doc.link(x, y - 9, w, 12, { url });
        }
        x += w;
      });
      y += 14;
    }

    y += 2;
    y = drawHr(doc, y) + 8;

    if (r.summary) {
      y = sectionHeader(doc, 'Professional Summary', y);
      y = emitText(doc, r.summary, y, { size: 10.5, leading: 1.5 });
      y += 6;
    }

    const skills = Array.isArray(r.skills) ? r.skills : [];
    if (skills.length) {
      y = sectionHeader(doc, 'Skills', y);
      for (const s of skills) {
        const cat = String(s.category || '');
        const items = String(s.items || '');
        if (!cat && !items) continue;
        const line = cat ? `${cat}: ${items}` : items;
        y = emitText(doc, line, y, { size: 10.5, leading: 1.5 });
      }
      y += 4;
    }

    const experience = Array.isArray(r.experience) ? r.experience : [];
    if (experience.length) {
      y = sectionHeader(doc, 'Experience', y);
      for (const j of experience) {
        y = pageBreakIfNeeded(doc, y, 40);
        // Company + location LEFT, dates RIGHT
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(0, 0, 0);
        const companyText = `${j.company || ''}${j.location ? ', ' + j.location : ''}`;
        doc.text(companyText, PAGE.mLeft, y);
        if (j.dates) {
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(10.5);
          doc.setTextColor(60, 60, 60);
          const dw = doc.getTextWidth(j.dates);
          doc.text(j.dates, PAGE.w - PAGE.mRight - dw, y);
        }
        y += 14;
        if (j.role) {
          y = emitText(doc, j.role, y, { size: 10.5, style: 'italic', color: [60, 60, 60], leading: 1.35 });
        }
        const bullets = (j.bullets || []).filter(Boolean);
        for (const b of bullets) {
          y = pageBreakIfNeeded(doc, y, 16);
          // bullet glyph + indented text
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(10.5);
          doc.setTextColor(0, 0, 0);
          doc.text('•', PAGE.mLeft + 6, y);
          y = emitText(doc, b, y, { size: 10.5, leading: 1.5, indent: 16 });
        }
        y += 6;
      }
    }

    const education = Array.isArray(r.education) ? r.education : [];
    if (education.length) {
      y = sectionHeader(doc, 'Education', y);
      for (const e of education) {
        const parts = [e.degree, e.school, e.year, e.detail].filter(Boolean);
        y = emitText(doc, parts.join(' · '), y, { size: 10.5, leading: 1.5 });
      }
      y += 4;
    }

    const projects = Array.isArray(r.projects) ? r.projects : [];
    if (projects.length) {
      y = sectionHeader(doc, 'Projects', y);
      for (const p of projects) {
        y = pageBreakIfNeeded(doc, y, 30);
        const head = `${p.name || ''}${p.tech ? ' · ' + p.tech : ''}`;
        if (head.trim()) y = emitText(doc, head, y, { size: 11, style: 'bold', leading: 1.3 });
        if (p.summary) y = emitText(doc, p.summary, y, { size: 10.5, leading: 1.5 });
        y += 4;
      }
    }

    return doc;
  }

  // ── Pro templates ──────────────────────────────────────────────
  // Two Pro-only looks, both same content order + ATS-safe real text as the
  // classic builder (core fonts only, no font embedding, no tables/images):
  //   - Modern:   helvetica, sage accent rules, two-column skills (clean/startup)
  //   - Executive: Times serif, centered header, letter-spaced heads (formal/traditional)
  const SAGE = [63, 126, 92];  // --sage #3f7e5c (matches app brand, AA-safe)
  const INK = [26, 26, 26];    // near-black body, softer than pure #000

  // Modern: sage accent rule + bold heading. Reserves space so it never orphans.
  function sectionHeaderModern(doc, label, y, nextItemHeight = 50) {
    y = pageBreakIfNeeded(doc, y, 24 + nextItemHeight);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(SAGE[0], SAGE[1], SAGE[2]);
    doc.text(label.toUpperCase(), PAGE.mLeft, y);
    y += 5;
    doc.setDrawColor(SAGE[0], SAGE[1], SAGE[2]);
    doc.setLineWidth(1.1);
    doc.line(PAGE.mLeft, y, PAGE.w - PAGE.mRight, y);
    return y + 12;
  }

  function buildResumePdfModern(jsPDF, r) {
    const doc = new jsPDF({ unit: 'pt', format: 'letter', compress: true });
    if (typeof doc.setLanguage === 'function') doc.setLanguage('en-US');
    doc.setProperties({
      title: `${r.name || 'Resume'}, Resume`,
      author: r.name || '',
      subject: 'Resume',
      creator: 'Resume Prune',
    });
    let y = PAGE.mTop + 24;

    // Name, dominant. 24pt vs classic 22pt, ink not pure black.
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(24);
    doc.setTextColor(INK[0], INK[1], INK[2]);
    doc.text(String(r.name || ''), PAGE.mLeft, y);
    y += 20;

    if (r.title_line) {
      y = emitText(doc, r.title_line, y, { size: 11.5, style: 'bold', leading: 1.25, color: SAGE });
    }

    // Contact line: email · phone · location (clickable email)
    const contactBits = [r.contact?.email, r.contact?.phone, r.contact?.location].filter(Boolean);
    if (contactBits.length) {
      const line = contactBits.join('  ·  ');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10.5);
      doc.setTextColor(70, 70, 70);
      doc.text(line, PAGE.mLeft, y);
      if (r.contact?.email) {
        const emailW = doc.getTextWidth(r.contact.email);
        doc.link(PAGE.mLeft, y - 9, emailW, 12, { url: 'mailto:' + r.contact.email });
      }
      y += 14;
    }

    // Links line: clickable URLs
    const links = (r.contact?.links || []).filter(Boolean);
    if (links.length) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(70, 70, 70);
      let x = PAGE.mLeft;
      links.forEach((u, i) => {
        if (i > 0) {
          doc.text('  ·  ', x, y);
          x += doc.getTextWidth('  ·  ');
        }
        const w = doc.getTextWidth(u);
        doc.text(u, x, y);
        if (/^https?:\/\//i.test(u) || /^www\./i.test(u)) {
          const url = /^https?:\/\//i.test(u) ? u : 'https://' + u;
          doc.link(x, y - 9, w, 12, { url });
        }
        x += w;
      });
      y += 14;
    }

    y += 6;

    if (r.summary) {
      y = sectionHeaderModern(doc, 'Professional Summary', y);
      y = emitText(doc, r.summary, y, { size: 10.5, leading: 1.5, color: INK });
      y += 8;
    }

    // Skills as a two-column block: "Category: items" pairs laid left/right.
    const skills = (Array.isArray(r.skills) ? r.skills : []).filter(s => {
      return String(s.category || '') || String(s.items || '');
    });
    if (skills.length) {
      y = sectionHeaderModern(doc, 'Skills', y);
      const colGap = 18;
      const colW = (CONTENT_W - colGap) / 2;
      const colX = [PAGE.mLeft, PAGE.mLeft + colW + colGap];
      // Pre-wrap each skill entry into lines, so a two-line entry keeps its
      // column. Rows advance by the taller of the paired entries.
      const entries = skills.map(s => {
        const cat = String(s.category || '');
        const items = String(s.items || '');
        const text = cat ? `${cat}: ${items}` : items;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        return { cat, lines: doc.splitTextToSize(text, colW) };
      });
      const lineH = 10 * 1.4;
      for (let i = 0; i < entries.length; i += 2) {
        const pair = [entries[i], entries[i + 1]].filter(Boolean);
        const rowLines = Math.max(...pair.map(e => e.lines.length));
        y = pageBreakIfNeeded(doc, y, rowLines * lineH + 2);
        const rowTop = y;
        pair.forEach((e, ci) => {
          let yy = rowTop;
          e.lines.forEach((ln, li) => {
            // Bold just the "Category:" label on the first line for scannability.
            if (li === 0 && e.cat) {
              const label = e.cat + ':';
              doc.setFont('helvetica', 'bold');
              doc.setFontSize(10);
              doc.setTextColor(INK[0], INK[1], INK[2]);
              doc.text(label, colX[ci], yy);
              const lw = doc.getTextWidth(label + ' ');
              const rest = ln.slice(label.length).replace(/^\s+/, '');
              doc.setFont('helvetica', 'normal');
              doc.text(rest, colX[ci] + lw, yy);
            } else {
              doc.setFont('helvetica', 'normal');
              doc.setFontSize(10);
              doc.setTextColor(INK[0], INK[1], INK[2]);
              doc.text(ln, colX[ci], yy);
            }
            yy += lineH;
          });
        });
        y = rowTop + rowLines * lineH + 2;
      }
      y += 6;
    }

    const experience = Array.isArray(r.experience) ? r.experience : [];
    if (experience.length) {
      y = sectionHeaderModern(doc, 'Experience', y);
      for (const j of experience) {
        y = pageBreakIfNeeded(doc, y, 42);
        // Company + location LEFT, dates RIGHT-aligned tab
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(INK[0], INK[1], INK[2]);
        const companyText = `${j.company || ''}${j.location ? ', ' + j.location : ''}`;
        doc.text(companyText, PAGE.mLeft, y);
        if (j.dates) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(10);
          doc.setTextColor(90, 90, 90);
          const dw = doc.getTextWidth(j.dates);
          doc.text(j.dates, PAGE.w - PAGE.mRight - dw, y);
        }
        y += 14;
        if (j.role) {
          y = emitText(doc, j.role, y, { size: 10.5, style: 'italic', color: SAGE, leading: 1.3 });
        }
        const bullets = (j.bullets || []).filter(Boolean);
        for (const b of bullets) {
          y = pageBreakIfNeeded(doc, y, 15);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(10.5);
          doc.setTextColor(SAGE[0], SAGE[1], SAGE[2]);
          doc.text('•', PAGE.mLeft + 6, y);
          // Tighter bullet leading than classic (1.4 vs 1.5)
          y = emitText(doc, b, y, { size: 10.5, leading: 1.4, indent: 16, color: INK });
        }
        y += 8;
      }
    }

    const education = Array.isArray(r.education) ? r.education : [];
    if (education.length) {
      y = sectionHeaderModern(doc, 'Education', y);
      for (const e of education) {
        const parts = [e.degree, e.school, e.year, e.detail].filter(Boolean);
        y = emitText(doc, parts.join(' · '), y, { size: 10.5, leading: 1.5, color: INK });
      }
      y += 6;
    }

    const projects = Array.isArray(r.projects) ? r.projects : [];
    if (projects.length) {
      y = sectionHeaderModern(doc, 'Projects', y);
      for (const p of projects) {
        y = pageBreakIfNeeded(doc, y, 30);
        const head = `${p.name || ''}${p.tech ? ' · ' + p.tech : ''}`;
        if (head.trim()) y = emitText(doc, head, y, { size: 11, style: 'bold', leading: 1.3, color: INK });
        if (p.summary) y = emitText(doc, p.summary, y, { size: 10.5, leading: 1.45, color: INK });
        y += 6;
      }
    }

    return doc;
  }

  // Executive template (Pro). Times serif, centered header, letter-spaced
  // section heads with a thin rule, en-dash bullets, wider margins. A formal /
  // traditional look distinct from the two helvetica templates. Still core
  // fonts (Times ships with jsPDF), single column, real text, ATS-safe.
  const EXEC = { L: 54, R: 54 };            // wider side margins for a formal feel
  const EXEC_W = PAGE.w - EXEC.L - EXEC.R;
  const EXEC_BULLET = '–';             // en dash (NOT em dash) as list marker

  // Wrap serif text at x, page-breaking each line. Returns new y.
  function execWrap(doc, text, x, y, size, opts) {
    const o = opts || {};
    doc.setFont('times', o.style || 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...(o.color || INK));
    const lines = doc.splitTextToSize(String(text || ''), o.w || EXEC_W);
    const lh = size * (o.leading || 1.4);
    for (const ln of lines) {
      y = pageBreakIfNeeded(doc, y, lh);
      doc.text(ln, x, y);
      y += lh;
    }
    return y;
  }

  function execCenter(doc, text, y, size, style, color) {
    doc.setFont('times', style || 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...(color || INK));
    doc.text(String(text || ''), PAGE.w / 2, y, { align: 'center' });
    return y + size * 1.3;
  }

  // Letter-spaced (tracked) serif heading + thin gray rule. Reserves space so
  // it never orphans at the foot of a page.
  function execHead(doc, label, y, nextItemHeight = 46) {
    y = pageBreakIfNeeded(doc, y, 22 + nextItemHeight);
    doc.setFont('times', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...INK);
    // Hair tracking by spacing the caps; splitTextToSize is not involved (short).
    doc.text(label.toUpperCase().split('').join(' '), EXEC.L, y);
    y += 4;
    doc.setDrawColor(150, 150, 150);
    doc.setLineWidth(0.5);
    doc.line(EXEC.L, y, PAGE.w - EXEC.R, y);
    return y + 14;
  }

  function buildResumePdfExecutive(jsPDF, r) {
    const doc = new jsPDF({ unit: 'pt', format: 'letter', compress: true });
    if (typeof doc.setLanguage === 'function') doc.setLanguage('en-US');
    doc.setProperties({
      title: `${r.name || 'Resume'}, Resume`,
      author: r.name || '',
      subject: 'Resume',
      creator: 'Resume Prune',
    });
    let y = PAGE.mTop + 12;

    // Centered header block
    y = execCenter(doc, r.name || '', y + 8, 26, 'bold');
    if (r.title_line) y = execCenter(doc, r.title_line, y + 2, 11.5, 'italic', [70, 70, 70]);
    const contactBits = [r.contact?.email, r.contact?.phone, r.contact?.location].filter(Boolean);
    if (contactBits.length) y = execCenter(doc, contactBits.join('   |   '), y + 4, 10, 'normal', [70, 70, 70]);
    const links = (r.contact?.links || []).filter(Boolean);
    if (links.length) y = execCenter(doc, links.join('   |   '), y, 10, 'normal', [70, 70, 70]);
    y += 12;

    if (r.summary) {
      y = execHead(doc, 'Professional Summary', y);
      y = execWrap(doc, r.summary, EXEC.L, y, 10.5, { leading: 1.45 });
      y += 12;
    }

    const skills = (Array.isArray(r.skills) ? r.skills : []).filter(s => String(s.category || '') || String(s.items || ''));
    if (skills.length) {
      y = execHead(doc, 'Skills', y);
      for (const s of skills) {
        const cat = String(s.category || '');
        const items = String(s.items || '');
        y = pageBreakIfNeeded(doc, y, 10.5 * 1.5);
        if (cat) {
          const label = cat + ':  ';
          doc.setFont('times', 'bold');
          doc.setFontSize(10.5);
          doc.setTextColor(...INK);
          doc.text(label, EXEC.L, y);
          const lw = doc.getTextWidth(label);
          // Items may wrap; hang them past the label on the first line.
          const wrapped = doc.splitTextToSize(items, EXEC_W - lw);
          doc.setFont('times', 'normal');
          doc.text(wrapped[0] || '', EXEC.L + lw, y);
          y += 10.5 * 1.5;
          for (let i = 1; i < wrapped.length; i++) {
            y = pageBreakIfNeeded(doc, y, 10.5 * 1.5);
            doc.text(wrapped[i], EXEC.L + lw, y);
            y += 10.5 * 1.5;
          }
        } else {
          y = execWrap(doc, items, EXEC.L, y, 10.5, { leading: 1.5 });
        }
      }
      y += 8;
    }

    const experience = Array.isArray(r.experience) ? r.experience : [];
    if (experience.length) {
      y = execHead(doc, 'Experience', y);
      for (const j of experience) {
        y = pageBreakIfNeeded(doc, y, 42);
        doc.setFont('times', 'bold');
        doc.setFontSize(11.5);
        doc.setTextColor(...INK);
        doc.text(`${j.company || ''}${j.location ? ', ' + j.location : ''}`, EXEC.L, y);
        if (j.dates) {
          doc.setFont('times', 'italic');
          doc.setFontSize(10.5);
          doc.setTextColor(90, 90, 90);
          const dw = doc.getTextWidth(j.dates);
          doc.text(j.dates, PAGE.w - EXEC.R - dw, y);
        }
        y += 14;
        if (j.role) y = execWrap(doc, j.role, EXEC.L, y, 10.5, { style: 'italic', color: [90, 90, 90], leading: 1.3 });
        const bullets = (j.bullets || []).filter(Boolean);
        for (const b of bullets) {
          y = pageBreakIfNeeded(doc, y, 15);
          doc.setFont('times', 'normal');
          doc.setFontSize(10.5);
          doc.setTextColor(...INK);
          doc.text(EXEC_BULLET, EXEC.L + 4, y);
          y = execWrap(doc, b, EXEC.L + 20, y, 10.5, { leading: 1.4, w: EXEC_W - 20 });
        }
        y += 8;
      }
    }

    const education = Array.isArray(r.education) ? r.education : [];
    if (education.length) {
      y = execHead(doc, 'Education', y);
      for (const e of education) {
        const parts = [e.degree, e.school, e.year, e.detail].filter(Boolean);
        y = execWrap(doc, parts.join(' · '), EXEC.L, y, 10.5, { leading: 1.5 });
      }
      y += 8;
    }

    const projects = Array.isArray(r.projects) ? r.projects : [];
    if (projects.length) {
      y = execHead(doc, 'Projects', y);
      for (const p of projects) {
        y = pageBreakIfNeeded(doc, y, 30);
        const head = `${p.name || ''}${p.tech ? ' · ' + p.tech : ''}`;
        if (head.trim()) {
          doc.setFont('times', 'bold');
          doc.setFontSize(11);
          doc.setTextColor(...INK);
          doc.text(head, EXEC.L, y);
          y += 14;
        }
        if (p.summary) y = execWrap(doc, p.summary, EXEC.L, y, 10.5, { leading: 1.45 });
        y += 6;
      }
    }

    return doc;
  }

  function buildCoverPdf(jsPDF, c) {
    const doc = new jsPDF({ unit: 'pt', format: 'letter', compress: true });
    if (typeof doc.setLanguage === 'function') doc.setLanguage('en-US');
    const displayName = fixNameCase(c.name || '');
    doc.setProperties({
      title: `${displayName || 'Cover Letter'}, Cover Letter`,
      author: displayName,
      subject: 'Cover Letter',
      creator: 'Resume Prune',
    });
    let y = PAGE.mTop + 14;

    // Sender block, name + contact (right-aligned would be classic but
    // left-aligned reads cleaner with modern tools; keep with resume).
    if (displayName) y = emitText(doc, displayName, y, { size: 12, style: 'bold', leading: 1.3 });
    const contactBits = [c.contact?.email, c.contact?.phone, c.contact?.location].filter(Boolean);
    if (contactBits.length) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(60, 60, 60);
      doc.text(contactBits.join('  ·  '), PAGE.mLeft, y);
      if (c.contact?.email) {
        const emailW = doc.getTextWidth(c.contact.email);
        doc.link(PAGE.mLeft, y - 9, emailW, 12, { url: 'mailto:' + c.contact.email });
      }
      y += 14;
    }
    y += 14;

    // Date
    const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    y = emitText(doc, today, y, { size: 10.5, color: [70, 70, 70] });
    y += 14;

    // Greeting
    y = emitText(doc, c.greeting || 'Dear Hiring Manager,', y, { size: 11, style: 'normal' });
    y += 10;

    // Body paragraphs, 1.6 leading for readability (standard for body copy)
    const paragraphs = (c.paragraphs || []).filter(Boolean);
    for (const p of paragraphs) {
      y = emitText(doc, p, y, { size: 11, leading: 1.6 });
      y += 12;
    }
    y += 4;

    // Signoff + name with real-letter spacing (~3 blank lines for a hand signature).
    // Name is NORMAL weight here, bold would read aggressive on a sign-off.
    y = emitText(doc, c.signoff || 'Sincerely,', y, { size: 11, style: 'normal' });
    y += 30; // signature whitespace
    if (displayName) y = emitText(doc, displayName, y, { size: 11, style: 'normal' });

    return doc;
  }

  // template: 'classic' (free) | 'modern' | 'executive' (Pro). Unknown => classic.
  const RESUME_BUILDERS = {
    classic: buildResumePdf,
    modern: buildResumePdfModern,
    executive: buildResumePdfExecutive,
  };

  async function downloadResumePdf(resumeJson, filename, template) {
    const jsPDF = await loadJsPdf();
    const build = RESUME_BUILDERS[template] || buildResumePdf;
    const doc = build(jsPDF, resumeJson || {});
    doc.save(filename || `${slug(resumeJson?.name)}-resume.pdf`);
  }

  async function downloadCoverPdf(coverJson, filename) {
    const jsPDF = await loadJsPdf();
    const doc = buildCoverPdf(jsPDF, coverJson || {});
    doc.save(filename || `${slug(coverJson?.name)}-cover.pdf`);
  }

  // Strip filename-hostile characters (Windows-incompatible set) and collapse
  // whitespace. Leaves spaces intact, modern OSes handle them fine and they
  // read more like a file the user named themselves.
  function safeFilenamePart(s) {
    return String(s ?? '')
      .replace(/[\/\\:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Builds "Jane Doe - Acme Pay resume.pdf" or "Jane Doe resume.pdf" depending
  // on what's available. kind is 'resume' or 'cover letter'.
  function buildFilename({ name, company, role, kind }) {
    const n = safeFilenamePart(name);
    const c = safeFilenamePart(company);
    const r = safeFilenamePart(role);
    const head = [n || 'resume-prune', c || r].filter(Boolean).join(' - ');
    return `${head} ${kind}.pdf`;
  }

  window.RP = window.RP || {};
  window.RP.downloadResumePdf = downloadResumePdf;
  window.RP.downloadCoverPdf = downloadCoverPdf;
  window.RP.buildResumePdf = buildResumePdf;
  window.RP.buildResumePdfModern = buildResumePdfModern;
  window.RP.buildResumePdfExecutive = buildResumePdfExecutive;
  window.RP.buildFilename = buildFilename;
  window.RP.safeFilenamePart = safeFilenamePart;
})();
