// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Standalone test for src/lib/resume-checks.js (rule-based cleanup suggestions, 2026-11-02).
// Run: node scripts/test-resume-checks.mjs
//
// Fixtures are one made-up resume before and after the five rules were applied.
// Before must trip rules 1, 3 and 5. After must come back clean.
import { resumeChecks } from '../src/lib/resume-checks.js';

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`); if (extra !== undefined) console.error('    ', JSON.stringify(extra, null, 2)); }
}
const NOW = new Date('2026-11-02T12:00:00Z');
const rules = items => items.map(i => i.rule);

const BEFORE_EDITS = {
  name: 'Sam Rivera',
  contact: { email: 'x@example.com', location: 'Springfield, OR' },
  summary: "I run a busy veterinary front desk and keep the day's schedule on track. My background is clinic management (12 years), and I like a calm waiting room.",
  skills: [
    { category: 'Clinic software', items: 'Cornerstone, ezyVet, Weave' },
    { category: 'Tools', items: 'QuickBooks, Square, Slack, Google Workspace, Microsoft Office' },
  ],
  experience: [
    { company: 'Maple Grove Animal Hospital', role: 'Practice Manager', dates: 'January 2022 – Present', bullets: ['a', 'b', 'c', 'd'] },
    { company: 'Lakeshore Pet Clinic', role: 'Office Manager', dates: 'May 2016 – December 2021', bullets: ['a', 'b', 'c'] },
    { company: 'County Animal Shelter', role: 'Volunteer Coordinator', dates: 'March 2019 – July 2019', bullets: ['a'] },
    { company: 'Riverside Kennels', role: 'Kennel Attendant', dates: 'June 2004 – August 2014', bullets: ['a', 'b'] },
  ],
};

const AFTER_EDITS = {
  ...BEFORE_EDITS,
  summary: "I run a busy veterinary front desk and keep the day's schedule on track. I have a long background in clinic management, and I like a calm waiting room.",
  skills: [
    { category: 'Clinic software', items: 'Cornerstone, ezyVet, Weave' },
    { category: 'Tools', items: 'QuickBooks, Square, Slack, Google Workspace' },
  ],
  experience: [
    ...BEFORE_EDITS.experience.slice(0, 3),
    { company: 'Riverside Kennels', role: 'Kennel Attendant', dates: 'Until 2014', bullets: ['a'] },
  ],
};

console.log("sample resume, before");
const before = resumeChecks(BEFORE_EDITS, '', '', NOW);
ok('rule 1 catches "12 years"', before.some(i => i.rule === 1 && i.label.includes('12 years')), before);
ok('rule 2 stays quiet on a 2-sentence summary', !rules(before).includes(2));
ok('rule 3 flags the 2004 start year', before.some(i => i.rule === 3 && i.label.includes('2004')), before);
ok('rule 3 leaves Lakeshore Pet Clinic alone (ended 2021)', !before.some(i => i.label.includes('Lakeshore')));
ok('rule 5 flags Microsoft Office', before.some(i => i.rule === 5 && i.label.includes('Microsoft Office')));
ok('rule 5 leaves Google Workspace alone', !before.some(i => i.label.includes('Google Workspace')));
ok('city and state is not a street address', !before.some(i => i.label === 'Street address'));

console.log("sample resume, after");
const after = resumeChecks(AFTER_EDITS, '', '', NOW);
ok('comes back clean', after.length === 0, after);

console.log('posting names the software');
const withJd = resumeChecks(BEFORE_EDITS, '', 'Must know Microsoft Office and QuickBooks.', NOW);
ok('Microsoft Office is not flagged when the posting asks for it', !withJd.some(i => i.label.includes('Microsoft Office')));

console.log('a cluttered resume');
const RAW = `JANE DOE\n123 Maple Street, Springfield, IL 62704\njane@example.com\n\nKEY ACHIEVEMENTS\n- Cut costs 20%\n\nEXPERIENCE`;
const messy = {
  name: 'Jane Doe',
  contact: { location: '123 Maple Street, Springfield, IL 62704' },
  summary: 'Results-driven, passionate leader with over two decades in retail. I run stores. I hire people. I train teams. I fix schedules.',
  skills: [{ category: 'Skills', items: 'Team player, Detail-oriented, Microsoft Office, Excel, Typing, Excel' }],
  experience: [
    { company: 'Shop A', dates: '2022 - Present', bullets: ['one'] },
    { company: 'Shop B', dates: '2003 - 2008', bullets: ['a', 'b', 'c', 'd'] },
  ],
  education: [{ degree: 'BA', school: 'State U', year: '2002', detail: 'GPA 3.8' }],
};
const m = resumeChecks(messy, RAW, '', NOW);
ok('rule 1 catches "over two decades"', m.some(i => i.rule === 1));
ok('rule 2 catches a 5-sentence summary', m.some(i => i.rule === 2));
ok('rule 3 suggests cutting a role that ended in 2008', m.some(i => i.rule === 3 && i.label.includes('ended in 2008')));
ok('rule 3 notices the recent job is thinner', m.some(i => i.rule === 3 && i.label.includes('fewer bullets')));
ok('rule 4 catches KEY ACHIEVEMENTS', m.some(i => i.rule === 4));
ok('rule 5 catches soft skills', m.some(i => i.label.startsWith('Generic soft skills') && i.label.includes('Team player')));
ok('rule 5 catches buzzwords', m.some(i => i.label.startsWith('Buzzwords') && i.label.includes('results-driven')));
ok('a buzzword is named once, not once per spelling', resumeChecks({ summary: 'Results driven and results-driven.' }, '', '', NOW).find(i => i.label.startsWith('Buzzwords'))?.label === 'Buzzwords: results-driven');
ok('soft skills are not listed again as buzzwords', !m.some(i => i.label.startsWith('Buzzwords') && /team player|detail-oriented/i.test(i.label)));
ok('rule 5 catches basic tech but not Excel', m.some(i => i.label.startsWith('Basic software') && i.label.includes('Typing') && !i.label.includes('Excel')));
ok('rule 5 catches the graduation year', m.some(i => i.label.includes('Graduation year: 2002')));
ok('rule 5 catches the GPA', m.some(i => i.label === 'Grades on your resume'));
ok('rule 5 catches the street address', m.some(i => i.label === 'Street address'));
ok('capped at 12 items', m.length <= 12);

console.log('copy rules on every note');
for (const i of [...before, ...m]) {
  const t = i.label + ' ' + i.note;
  ok(`no em dash or semicolon: ${i.label.slice(0, 40)}`, !/[—;]/.test(t));
}

console.log('bad input');
ok('null parsed returns []', Array.isArray(resumeChecks(null)) && resumeChecks(null).length === 0);
ok('junk shapes do not throw', Array.isArray(resumeChecks({ experience: [null, { dates: 5 }], skills: [null, 3], education: 'x' })));

console.log('hostile input stays fast');
{
  const ws = ' '.repeat(20000) + '\n'.repeat(20000) + 'x';
  const hostile = { summary: '1' + ' '.repeat(20000) + 'x', experience: [{ dates: ' '.repeat(5000), bullets: [] }] };
  const t = Date.now();
  resumeChecks(hostile, ws, '', NOW);
  resumeChecks({ summary: 'x' }, '\t'.repeat(40000) + 'achievements', '', NOW);
  ok('40k characters of blank space checks in under 200ms', Date.now() - t < 200, Date.now() - t);
  ok('"  Key   Achievements:" with extra spaces still counts', resumeChecks({}, '  Key   Achievements:', '', NOW).some(i => i.rule === 4));
  ok('"10+ years" still counts', resumeChecks({ summary: 'Over 10+ years in ops.' }, '', '', NOW).some(i => i.rule === 1));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
