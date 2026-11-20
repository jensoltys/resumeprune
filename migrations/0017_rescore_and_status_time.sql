-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Resume Prune authors. See LICENSE.
-- Round 2 (2026-09-27).
-- rescores: how many times a tweak's match was re-checked after a gap fill. The first
--   re-check is free, later ones spend a tweak. Enforced in tweak-routes.
-- status_updated_at: when the job-tracker status last changed, for the "gone quiet" nudge.
--   Existing rows start at the migration time, so nothing nudges until 14 days from now
--   instead of every old application nudging at once.
ALTER TABLE tweaks ADD COLUMN rescores INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tweaks ADD COLUMN status_updated_at INTEGER;
UPDATE tweaks SET status_updated_at = CAST(strftime('%s', 'now') AS INTEGER);
