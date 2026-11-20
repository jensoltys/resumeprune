// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
const TRANSIENT_STATUSES = new Set([429, 502, 503, 529]);
// Default chain prefers Sonnet then falls back to Haiku.
// Per-call sites may pass `models` to override (e.g. analyze + cover prefer Haiku to cut cost).
const DEFAULT_MODEL_CHAIN = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
// Cheap-first chain: try Haiku first, fall back to Sonnet only on outage.
export const HAIKU_FIRST_CHAIN = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'];
// Sonnet-only chain: for the resume rewrite where quality matters most.
export const SONNET_FIRST_CHAIN = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
const ATTEMPTS_PER_MODEL = 2;

export async function callClaude(env, { system, userMessage, maxTokens, models }) {
  if (!env.ANTHROPIC_API_KEY) {
    const err = new Error('ANTHROPIC_API_KEY not configured');
    err.code = 'NO_AI_KEY';
    throw err;
  }
  const chain = Array.isArray(models) && models.length ? models : DEFAULT_MODEL_CHAIN;

  let claudeResp;
  let lastStatus, lastDetail = '', modelUsed;
  outer: for (const model of chain) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_MODEL; attempt++) {
      try {
        claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            system,
            messages: [{ role: 'user', content: userMessage }],
          }),
        });
      } catch (e) {
        lastDetail = String(e);
        await new Promise(r => setTimeout(r, 600 * attempt));
        continue;
      }
      if (claudeResp.ok) { modelUsed = model; break outer; }
      lastStatus = claudeResp.status;
      if (!TRANSIENT_STATUSES.has(claudeResp.status)) {
        const txt = await claudeResp.text();
        const err = new Error(`Anthropic ${claudeResp.status}`);
        err.status = claudeResp.status;
        err.detail = txt.slice(0, 400);
        throw err;
      }
      lastDetail = `${model} returned ${claudeResp.status}`;
      await new Promise(r => setTimeout(r, 800 * attempt));
    }
  }

  if (!claudeResp || !claudeResp.ok) {
    const err = new Error(`Anthropic exhausted (last: ${lastStatus || 'network'})`);
    err.status = 502;
    err.detail = lastDetail;
    throw err;
  }

  const data = await claudeResp.json();
  // Read the TEXT blocks by type, never content[0]: newer models can put a
  // thinking block first, which made content[0].text come back empty.
  const text = (Array.isArray(data?.content) ? data.content : [])
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text).join('');
  const stopReason = data?.stop_reason || null;
  return { text, modelUsed, stopReason };
}

// Remove trailing commas — `[1, 2, ]` / `{"a": 1, }` — which JSON.parse rejects
// outright. Claude emits one every ~10-14 generations (measured 2026-07-29 on
// claude-haiku-4-5 cover letters), and it used to fail the whole request.
//
// String-aware on purpose: a naive /,(\s*[}\]])/ would also rewrite real
// content like "tokens: a, ] and b" sitting inside a string value. Tracks
// string state and backslash escapes so only structural commas are touched.
function stripTrailingCommas(s) {
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      out += c;
      if (c === '\\') { out += s[++i] ?? ''; continue; } // escape consumes the next char
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === ',') {
      // Look past whitespace: a comma followed by a close bracket is trailing.
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') continue; // drop it, keep the whitespace
    }
    out += c;
  }
  return out;
}

// Best-effort JSON extraction from Claude responses. Tries, in order:
//   1. The whole text as JSON (the happy path when Claude follows "JSON only")
//   2. Content of a ```json … ``` fenced block
//   3. The outermost balanced { … } object found in the text (handles cases
//      where Claude wraps the JSON in commentary it wasn't supposed to)
// Each candidate is parsed strictly first, then retried with trailing commas
// stripped. Anything still unparseable is genuinely broken and returns null.
export function parseJsonFromText(text) {
  if (!text) return null;
  const trimmed = String(text).trim();

  const tryParse = (candidate) => {
    if (!candidate) return undefined;
    try { return JSON.parse(candidate); } catch {}
    try { return JSON.parse(stripTrailingCommas(candidate)); } catch {}
    return undefined;
  };

  // Path 1: clean JSON
  let parsed = tryParse(trimmed);
  if (parsed !== undefined) return parsed;

  // Path 2: fenced block
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    parsed = tryParse(fence[1].trim());
    if (parsed !== undefined) return parsed;
  }

  // Path 3: find the outermost {…} block, balancing braces.
  const start = trimmed.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          parsed = tryParse(trimmed.slice(start, i + 1));
          if (parsed !== undefined) return parsed;
          break;
        }
      }
    }
  }
  return null;
}
