-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Resume Prune authors. See LICENSE.
-- 0014: gap fills name the job where the experience happened. Stored as a
-- display label ("Role at Company (dates)"). Fills saved before this migration
-- have NULL job; prompts simply omit the Job line for those.
ALTER TABLE gap_fills ADD COLUMN job TEXT;
