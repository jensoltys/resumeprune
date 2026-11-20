-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Resume Prune authors. See LICENSE.
-- Plan 2 — Pro experience tables.
-- Builds on 0001 (users, email_tokens, free_samples, rate_limits, feedback)
-- and 0002 (free_samples.result_json).

-- One canonical base resume per user.
CREATE TABLE resumes (
  uid             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  raw_text        TEXT NOT NULL,
  parsed_json     TEXT NOT NULL,
  source_filename TEXT,
  uploaded_at     INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Tweak history (one row per JD-targeted tweak, regardless of which outputs requested).
CREATE TABLE tweaks (
  id              TEXT PRIMARY KEY,
  uid             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jd              TEXT NOT NULL,
  role_title      TEXT,
  company_name    TEXT,
  analysis_json   TEXT,
  resume_json     TEXT,
  cover_json      TEXT,
  model_used      TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_tweaks_uid_date ON tweaks(uid, created_at DESC);

-- Usage gating. period_key encodes the period type:
--   YYYY-MM   for Pro (calendar month)
--   YYYY-Www  for Sprint (ISO week, e.g. 2026-W19)
CREATE TABLE usage_counters (
  uid             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_key      TEXT NOT NULL,
  tweaks_used     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, period_key)
);
