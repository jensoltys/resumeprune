// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Belt-and-suspenders scrub for Claude output.
// scrubVoice: strip em-dashes and any markdown-fence leakage from every string
//   in a parsed JSON tree.
// normalizeCover: enforce the cover-letter structural contract — exactly 3
//   paragraphs, signoff field separated, no signoff text leaking into
//   paragraphs. Belt-and-suspenders against the model returning 4 paragraphs
//   with the closer in the last slot.

const SIGNOFF_LIKE = /^\s*(best|sincerely|thanks|thank you|regards|warmly|cheers|kind regards|warm regards|all the best)\s*[,.!]?\s*$/i;

export function scrubString(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/—/g, ' - ')
    .replace(/–/g, ' - ')
    .replace(/```html\s*/gi, '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*$/g, '');
}

export function scrubVoice(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return scrubString(obj);
  if (Array.isArray(obj)) return obj.map(scrubVoice);
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) obj[k] = scrubVoice(obj[k]);
    return obj;
  }
  return obj;
}

function countWords(s) {
  return (String(s || '').trim().match(/\S+/g) || []).length;
}

// Truncate a paragraph at a sentence boundary so the result has ≤ targetWords.
// Walks sentences from the end, dropping until it fits. Falls back to a hard
// word cap if the paragraph is one giant sentence.
function trimParagraphToWords(text, targetWords) {
  const sentences = String(text).match(/[^.!?]+[.!?]+(?:\s+|$)/g) || [String(text)];
  let current = sentences.join('').trim();
  while (countWords(current) > targetWords && sentences.length > 1) {
    sentences.pop();
    current = sentences.join('').trim();
  }
  if (countWords(current) > targetWords) {
    const words = current.split(/\s+/).slice(0, targetWords);
    current = words.join(' ').replace(/[,;:]$/, '') + '.';
  }
  return current;
}

export function normalizeCover(cover) {
  if (!cover || typeof cover !== 'object') return cover;
  if (!Array.isArray(cover.paragraphs)) return cover;

  // Pull any trailing paragraph that's just a signoff word into the signoff field.
  while (cover.paragraphs.length > 0) {
    const last = cover.paragraphs[cover.paragraphs.length - 1];
    if (typeof last === 'string' && SIGNOFF_LIKE.test(last)) {
      const lifted = last.trim().replace(/[.!]$/, '');
      cover.paragraphs.pop();
      // Only adopt as signoff if signoff field was empty/missing.
      if (!cover.signoff || !String(cover.signoff).trim()) {
        cover.signoff = /,$/.test(lifted) ? lifted : lifted + ',';
      }
    } else {
      break;
    }
  }

  // Enforce exactly 3 paragraphs by truncating extras (keep the strongest 3).
  // If the model produced more than 3 substantive paragraphs, prefer the
  // first paragraph (hook) + the longest paragraph (proof) + the last
  // paragraph (close). This is heuristic but bounded and predictable.
  if (cover.paragraphs.length > 3) {
    const first = cover.paragraphs[0];
    const last = cover.paragraphs[cover.paragraphs.length - 1];
    const middle = cover.paragraphs.slice(1, -1);
    const longest = middle.reduce((best, p) => p.length > best.length ? p : best, middle[0] || '');
    cover.paragraphs = [first, longest, last];
  }

  // Enforce total length ≤ 220 words. If the model overshoots (it does, even
  // when told 'max 200 words'), trim the longest paragraph at sentence
  // boundary until total fits. This is the algorithmic guard so a chatty
  // model can't ship a 250-word cover regardless of prompt discipline.
  const TOTAL_MAX = 220;
  let total = cover.paragraphs.reduce((s, p) => s + countWords(p), 0);
  let safety = 5;
  while (total > TOTAL_MAX && safety-- > 0) {
    // Find the longest paragraph
    let longestIdx = 0;
    let longestLen = countWords(cover.paragraphs[0] || '');
    for (let i = 1; i < cover.paragraphs.length; i++) {
      const wc = countWords(cover.paragraphs[i]);
      if (wc > longestLen) { longestLen = wc; longestIdx = i; }
    }
    const overflow = total - TOTAL_MAX;
    const newTarget = Math.max(20, longestLen - overflow - 5); // -5 cushion
    cover.paragraphs[longestIdx] = trimParagraphToWords(cover.paragraphs[longestIdx], newTarget);
    total = cover.paragraphs.reduce((s, p) => s + countWords(p), 0);
  }

  return cover;
}
