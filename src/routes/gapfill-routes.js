// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
import { res, readJson, nowSec, uuid, requireSameOrigin } from '../helpers.js';
import { requireAuth } from '../auth.js';
import { rateLimit } from '../ratelimit.js';
import { effectivePlan, planLimit } from '../lib/usage.js';

// Gap fills: when the match analysis lists a JD requirement the resume doesn't
// cover, the user can save a chunk of real experience that covers it. Fills
// live on the account (not the tweak) so every future analyze/tailor/cover
// run can draw on them. Saving is free; the reruns that use them are the
// quota-counted actions.

const MAX_FILLS = 50;
const GAP_MAX = 200;
const JOB_MAX = 160;
const BODY_MIN = 20;
const BODY_MAX = 2000;

// Shared with prompt building: load a user's fills, oldest first so the
// prompt reads chronologically.
export async function loadGapFills(env, uid) {
  const { results } = await env.DB.prepare(
    `SELECT id, gap, job, body, created_at FROM gap_fills WHERE uid = ? ORDER BY created_at ASC`
  ).bind(uid).all();
  return results || [];
}

// The dropdown's job list: every job on the base resume, plus any job the
// user already added through a previous fill (so "add it once" sticks).
async function loadJobOptions(env, uid, fills) {
  const jobs = [];
  const row = await env.DB.prepare(
    `SELECT parsed_json FROM resumes WHERE uid = ?`
  ).bind(uid).first();
  if (row?.parsed_json) {
    try {
      const parsed = JSON.parse(row.parsed_json);
      for (const e of Array.isArray(parsed.experience) ? parsed.experience : []) {
        if (!e || (!e.role && !e.company)) continue;
        const label = `${e.role || 'Role'} at ${e.company || 'Unknown'}${e.dates ? ` (${e.dates})` : ''}`.slice(0, JOB_MAX);
        if (!jobs.includes(label)) jobs.push(label);
      }
    } catch { /* corrupt parsed resume is handled by the tweak flow */ }
  }
  for (const f of fills) {
    if (f.job && !jobs.includes(f.job)) jobs.push(f.job);
  }
  return jobs;
}

// GET /api/gap-fills
export async function gapFillList(request, env) {
  const uid = await requireAuth(request, env);
  const fills = await loadGapFills(env, uid);
  const jobs = await loadJobOptions(env, uid, fills);
  return res({ fills, jobs, max: MAX_FILLS });
}

// POST /api/gap-fills  body: { gap, body }
export async function gapFillCreate(request, env) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const uid = await requireAuth(request, env);
  const burstBlock = await rateLimit(request, env, 'gap-fill', 15, 60, `uid:${uid}:gap-fill`);
  if (burstBlock) return burstBlock;

  // Paid feature: same gate as tweaks (Sprint or Pro, honoring gift expiry).
  const user = await env.DB.prepare(
    `SELECT plan, plan_expires, stripe_subscription_id FROM users WHERE id = ?`
  ).bind(uid).first();
  if (!user) throw res({ error: 'User not found' }, 404);
  if (planLimit(effectivePlan(user, env)) === 0) {
    throw res({
      error: 'Saving gap fills is for paid plans. Pick a paid plan.',
      code: 'NO_PLAN',
    }, 402);
  }

  const bodyJson = await readJson(request);
  const gap = typeof bodyJson.gap === 'string' ? bodyJson.gap.replace(/\s+/g, ' ').trim() : '';
  const job = typeof bodyJson.job === 'string' ? bodyJson.job.replace(/\s+/g, ' ').trim() : '';
  const body = typeof bodyJson.body === 'string' ? bodyJson.body.trim() : '';
  if (!gap || gap.length > GAP_MAX) {
    throw res({ error: `The gap label is required (max ${GAP_MAX} characters).` }, 400);
  }
  if (!job || job.length > JOB_MAX) {
    throw res({ error: `Pick the job where you did this (max ${JOB_MAX} characters).` }, 400);
  }
  if (body.length < BODY_MIN) {
    throw res({ error: 'Add a bit more detail. A sentence or two about what you did, where, and when gives the AI something real to work with.' }, 400);
  }
  if (body.length > BODY_MAX) {
    throw res({ error: `Keep it under ${BODY_MAX} characters. Save the highlights, not the memoir.` }, 400);
  }

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM gap_fills WHERE uid = ?`
  ).bind(uid).first();
  if ((count?.c || 0) >= MAX_FILLS) {
    throw res({ error: `You have ${MAX_FILLS} saved fills already. Delete one you no longer need first.` }, 409);
  }

  const id = uuid();
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO gap_fills (id, uid, gap, job, body, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, uid, gap, job, body, now).run();

  return res({ fill: { id, gap, job, body, created_at: now } }, 201);
}

// DELETE /api/gap-fills/:id
export async function gapFillDelete(request, env, fillId) {
  const originBlock = requireSameOrigin(request);
  if (originBlock) return originBlock;
  const uid = await requireAuth(request, env);
  const row = await env.DB.prepare(`SELECT uid FROM gap_fills WHERE id = ?`).bind(fillId).first();
  if (!row || row.uid !== uid) throw res({ error: 'Fill not found.' }, 404);
  await env.DB.prepare(`DELETE FROM gap_fills WHERE id = ?`).bind(fillId).run();
  return res({ ok: true });
}
