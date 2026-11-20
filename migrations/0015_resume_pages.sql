-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Resume Prune authors. See LICENSE.
-- Phase 6.2 — Hosted online resume (Pro).
-- A resume_page publishes ONE tweak's tailored resume at a public /r/:slug URL.
-- Only the rendered resume is ever public — never the analysis, cuts, or JD.
-- Soft-unpublish (unpublished_at) keeps the slug reserved so a stale link can
-- never later resolve to someone else's resume; the public route filters on it.
-- Both foreign keys cascade so account-delete and tweak-delete clean these up.

CREATE TABLE resume_pages (
  id             TEXT PRIMARY KEY,
  uid            TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  tweak_id       TEXT NOT NULL REFERENCES tweaks(id) ON DELETE CASCADE,
  slug           TEXT NOT NULL UNIQUE,
  indexable      INTEGER NOT NULL DEFAULT 0,   -- 0 = X-Robots noindex (default); 1 = allow search engines
  view_count     INTEGER NOT NULL DEFAULT 0,
  published_at   INTEGER NOT NULL,
  unpublished_at INTEGER                        -- NULL = live
);

CREATE INDEX idx_resume_pages_uid ON resume_pages(uid, published_at DESC);
