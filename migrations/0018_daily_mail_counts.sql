-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Resume Prune authors. See LICENSE.
-- 0018: app-wide daily email ceilings.
--
-- One row per (counter key, UTC day). Bumped with an atomic upsert
-- (INSERT ... ON CONFLICT DO UPDATE SET n = n + 1 RETURNING n), so parallel
-- requests can't both read "149" and both send. Keys hold no address or IP,
-- only fixed names like 'mail:signup' and 'mail:reset'. Old days are deleted
-- by the daily purge cron (src/lib/purge.js).
CREATE TABLE IF NOT EXISTS daily_counts (
  k    TEXT NOT NULL,
  day  TEXT NOT NULL,
  n    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (k, day)
);
