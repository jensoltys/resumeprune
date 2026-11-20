-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Resume Prune authors. See LICENSE.
-- Persist generated free-sample output so users can revisit a private link
-- (sent in their email) instead of being stuck on the page where they generated.
-- Stored 30 days, then a future cleanup job (or manual admin tool) drops them.
ALTER TABLE free_samples ADD COLUMN result_json TEXT;
