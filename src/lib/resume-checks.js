// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Rule-based resume cleanup checks (2026-11-02). No AI call, so the free sample stays cheap.
//
// Five suggestions aimed at age-bias triggers and lines worth deleting. An old role keeps one
// bullet and its END year only.
//
// These are SUGGESTIONS. Nothing here edits the resume. Each item is { rule, label, note }:
// label = what we saw, note = one plain line on why and what to try. Copy rules: no em dashes,
// no semicolons, contractions, and never a "recruiters say..." claim (two coaches' opinions,
// not research), so every note is phrased as a suggestion.
//
// Used by: /api/sample/analyze (free), /api/tweak/analyze (Pro), /api/profile/upload-resume.

const MAX_ITEMS = 12;

function str(v) { return typeof v === 'string' ? v : ''; }
function uniq(arr) { return [...new Set(arr)]; }
function listText(arr) { return arr.slice(0, 4).join(', ') + (arr.length > 4 ? ` and ${arr.length - 4} more` : ''); }
function jobName(j, i) { return str(j.company).trim() || str(j.role).trim() || `Role ${i + 1}`; }

// ── Rule 1: year counts in the summary ─────────────────────────────────────
const YEAR_COUNT_RES = [
  /\b\d{1,2} ?(?:\+ ?)?(?:years?|yrs?)\b/i,
  /\b(?:ten|eleven|twelve|fifteen|twenty|twenty-five|thirty) ?(?:\+ ?)?years?\b/i,
  /\b(?:over|more than|nearly|almost|two|three|several)\s+(?:a\s+)?decades?\b/i,
  /\bdecades?\s+of\b/i,
];

function checkYearCount(parsed) {
  const text = [str(parsed.headline), str(parsed.summary)].join(' ');
  for (const re of YEAR_COUNT_RES) {
    const m = text.match(re);
    if (m) {
      return {
        rule: 1,
        label: `Years of experience in your summary: "${m[0].trim()}"`,
        note: 'A year count puts a number on how long you\'ve worked, which can hint at your age. "A long background in..." or "extensive" makes the same point.',
      };
    }
  }
  return null;
}

// ── Rule 2: summary length ─────────────────────────────────────────────────
function checkSummaryLength(parsed) {
  const s = str(parsed.summary).trim();
  if (!s) return null;
  const n = s.split(/[.!?]+(?:\s+|$)/).filter(x => x.trim().length > 2).length;
  if (n <= 3) return null;
  return {
    rule: 2,
    label: `Your summary is ${n} sentences`,
    note: 'Two or three sentences is easier to scan. Keep the ones that say what you do and what you\'re good at.',
  };
}

// ── Rule 3: old roles get shorter, recent ones get the room ────────────────
// Years in a dates string. "Present", "Current" and "Now" count as this year.
function roleYears(dates, thisYear) {
  const d = str(dates);
  const years = (d.match(/\b(?:19|20)\d{2}\b/g) || []).map(Number).filter(y => y <= thisYear);
  if (/\b(present|current|now|today)\b/i.test(d)) years.push(thisYear);
  if (!years.length) return null;
  return { start: Math.min(...years), end: Math.max(...years) };
}

function checkOldRoles(parsed, thisYear) {
  const out = [];
  const exp = Array.isArray(parsed.experience) ? parsed.experience : [];
  const dated = exp.map((j, i) => ({ j, i, y: roleYears(j && j.dates, thisYear) })).filter(x => x.j && x.y);
  for (const { j, i, y } of dated) {
    if (y.end > thisYear - 10) continue; // ended in the last 10 years, so it isn't an old role
    const name = jobName(j, i);
    const bullets = Array.isArray(j.bullets) ? j.bullets.length : 0;
    if (y.end <= thisYear - 15) {
      out.push({
        rule: 3,
        label: `${name} ended in ${y.end}`,
        note: 'You could cut work from more than 15 years ago, unless it\'s your only proof of a skill this job needs. If you keep it, one line is enough.',
      });
    } else if (y.start <= thisYear - 15) {
      out.push({
        rule: 3,
        label: `${name} shows a start year of ${y.start}`,
        note: `This role ended more than 10 years ago. Try moving it under an "Earlier Experience" heading${bullets > 1 ? ' with one bullet' : ''} and showing only the year it ended.`,
      });
    } else if (bullets > 2) {
      out.push({
        rule: 3,
        label: `${name} has ${bullets} bullets`,
        note: 'This role ended more than 10 years ago. One or two bullets is plenty, so your recent work gets the room.',
      });
    }
  }
  // Recent role thinner than an old one.
  const recent = dated.filter(x => x.y.end > thisYear - 10).sort((a, b) => b.y.end - a.y.end)[0];
  const old = dated.filter(x => x.y.end <= thisYear - 10);
  if (recent && old.length) {
    const rb = Array.isArray(recent.j.bullets) ? recent.j.bullets.length : 0;
    const maxOld = Math.max(...old.map(x => (Array.isArray(x.j.bullets) ? x.j.bullets.length : 0)));
    if (rb < maxOld) {
      out.push({
        rule: 3,
        label: `${jobName(recent.j, recent.i)} has fewer bullets than an older job`,
        note: 'Give your most recent job at least as much room as the older ones, since it\'s the closest match to what you\'d do next.',
      });
    }
  }
  return out;
}

// ── Rule 4: a separate achievements section ────────────────────────────────
// Tested one trimmed line at a time, never across the whole paste. A single multiline regex
// with overlapping whitespace quantifiers hung for 2+ minutes on a paste of blank lines
//, and /api/sample/analyze is public.
const ACHIEVEMENTS_HEADING = /^(?:(?:key|selected|notable|major|professional|career|top) )?(?:achievements|accomplishments):?$/i;

function hasAchievementsHeading(rawText) {
  for (const line of str(rawText).split('\n')) {
    if (line.length > 80) continue;
    const t = line.replace(/^[#*•\- \t]+/, '').trim().replace(/[ \t]+/g, ' ');
    if (t.length <= 40 && ACHIEVEMENTS_HEADING.test(t)) return true;
  }
  return false;
}

function checkAchievementsSection(parsed, rawText) {
  if (!hasAchievementsHeading(rawText) && !/\b(?:key|selected|notable) (?:achievements|accomplishments)\b/i.test(str(parsed.extras))) return null;
  return {
    rule: 4,
    label: 'A separate achievements section',
    note: 'Move each achievement under the job where it happened, so the reader sees your title, the scope and the result together.',
  };
}

// ── Rule 5: things to delete ───────────────────────────────────────────────
// Basic software. Excel and PowerPoint are left alone on purpose: plenty of jobs test for them.
const BASIC_TECH = [
  { re: /^(?:microsoft|ms)\s*office(?:\s*(?:suite|365))?$/i, jd: /\b(?:microsoft|ms)\s*office\b|\boffice\s*365\b/i },
  { re: /^(?:microsoft\s+|ms\s+)?word$/i, jd: /\b(?:microsoft|ms)\s+word\b/i },
  { re: /^(?:microsoft\s+|ms\s+)?outlook$/i, jd: /\boutlook\b/i },
  { re: /^(?:e-?mail|internet|windows|typing|google docs)$/i, jd: null },
];

const SOFT_SKILLS = /^(?:team\s*player|hard[\s-]*working|hardworking|detail[\s-]*oriented|self[\s-]*starter|(?:highly\s+)?motivated|fast\s+learner|quick\s+learner|people\s+person|multi[\s-]*tasking|problem[\s-]*solver|problem[\s-]*solving|communication(?:\s+skills)?|interpersonal(?:\s+skills)?|time\s+management|positive\s+attitude|works?\s+well\s+under\s+pressure|organized|reliable|dependable|punctual)$/i;

// Each entry also matches its spaced and run-together spellings (the regex makes a hyphen or
// space optional), so list ONE spelling per word or the label repeats it.
const BUZZWORDS = [
  'results-driven', 'results-oriented', 'go-getter', 'thought leader', 'rock star',
  'ninja', 'guru', 'synergy', 'synergize', 'proven track record', 'think outside the box', 'best-in-class',
  'world-class', 'value-add', 'dynamic professional', 'seasoned', 'passionate', 'highly skilled', 'self-starter',
  'team player', 'detail-oriented', 'hard-working',
];

const STREET = /\b\d{1,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9.' ]{2,40}?\s(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|way|place|pl|terrace|ter|circle|cir|parkway|pkwy|highway|hwy)\b\.?/i;

function skillItems(parsed) {
  const skills = Array.isArray(parsed.skills) ? parsed.skills : [];
  const items = [];
  for (const s of skills) {
    const raw = typeof s === 'string' ? s : str(s && s.items);
    for (const part of raw.split(/[,;•|\n]/)) {
      const t = part.replace(/\(.*?\)/g, '').trim();
      if (t) items.push(t);
    }
  }
  return items;
}

function checkDeleteList(parsed, rawText, jd) {
  const out = [];
  const items = skillItems(parsed);
  const jdText = str(jd);

  const basic = uniq(items.filter(it => BASIC_TECH.some(b => b.re.test(it) && !(b.jd && b.jd.test(jdText)))));
  if (basic.length) {
    out.push({
      rule: 5,
      label: `Basic software in your skills: ${listText(basic)}`,
      note: jdText
        ? 'This posting doesn\'t ask for it. Skip software every office job expects and use the room for tools that set you apart.'
        : 'Skip software every office job expects, unless the posting names it. Use the room for tools that set you apart.',
    });
  }

  const soft = uniq(items.filter(it => SOFT_SKILLS.test(it)));
  if (soft.length) {
    out.push({
      rule: 5,
      label: `Generic soft skills: ${listText(soft)}`,
      note: 'Anyone can list these. Show them in a bullet instead, like a deadline you hit or a mess you sorted out.',
    });
  }

  const prose = [str(parsed.headline), str(parsed.summary),
    ...(Array.isArray(parsed.experience) ? parsed.experience.flatMap(j => (j && Array.isArray(j.bullets) ? j.bullets : [])) : [])]
    .join(' \n ').toLowerCase();
  const buzz = uniq(BUZZWORDS.filter(w => new RegExp(`(^|[^a-z])${w.replace(/[-\s]/g, '[-\\s]?')}([^a-z]|$)`, 'i').test(prose)))
    .filter(w => !soft.some(s => s.toLowerCase().replace(/[\s-]/g, '') === w.replace(/[\s-]/g, '')));
  if (buzz.length) {
    out.push({
      rule: 5,
      label: `Buzzwords: ${listText(buzz)}`,
      note: 'These read as filler. Say what you did and what changed because of it.',
    });
  }

  const edu = Array.isArray(parsed.education) ? parsed.education : [];
  const gradYears = uniq(edu.flatMap(e => (str(e && e.year) + ' ' + str(e && e.degree)).match(/\b(?:19|20)\d{2}\b/g) || []));
  if (gradYears.length) {
    out.push({
      rule: 5,
      label: `Graduation year: ${listText(gradYears)}`,
      note: 'The degree and school are enough. A year can hint at your age.',
    });
  }
  if (edu.some(e => /\bGPA\b|\b\d\.\d{1,2}\s*\/\s*4(?:\.0)?\b/i.test(str(e && e.detail) + ' ' + str(e && e.degree)))) {
    out.push({
      rule: 5,
      label: 'Grades on your resume',
      note: 'Once you have work history, you can drop the GPA.',
    });
  }

  const head = str(rawText).split('\n').slice(0, 10).join('\n');
  if (STREET.test(str(parsed.contact && parsed.contact.location)) || STREET.test(head)) {
    out.push({
      rule: 5,
      label: 'Street address',
      note: 'City and state are enough. A full address puts private details on every copy you send.',
    });
  }

  const seen = new Map();
  for (const it of items) { const k = it.toLowerCase(); seen.set(k, (seen.get(k) || 0) + 1); }
  const dupes = items.filter((it, i) => seen.get(it.toLowerCase()) > 1 && items.findIndex(x => x.toLowerCase() === it.toLowerCase()) === i);
  if (items.length > 30) {
    out.push({
      rule: 5,
      label: `A long skills list (${items.length} items)`,
      note: 'A list this long reads like keyword stuffing. Keep the skills you could talk about in an interview.',
    });
  } else if (dupes.length) {
    out.push({
      rule: 5,
      label: `Skills listed more than once: ${listText(dupes)}`,
      note: 'Once each is enough.',
    });
  }
  return out;
}

// parsed: PARSE_PROMPT JSON. rawText: the pasted resume. jd: the job description, when there is one.
export function resumeChecks(parsed, rawText = '', jd = '', now = new Date()) {
  if (!parsed || typeof parsed !== 'object') return [];
  const thisYear = now.getUTCFullYear();
  const items = [
    checkYearCount(parsed),
    checkSummaryLength(parsed),
    ...checkOldRoles(parsed, thisYear),
    checkAchievementsSection(parsed, rawText),
    ...checkDeleteList(parsed, rawText, jd),
  ].filter(Boolean);
  return items.slice(0, MAX_ITEMS);
}
