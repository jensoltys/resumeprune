-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Resume Prune authors. See LICENSE.
-- Replace plaintext email storage on free_samples with domain-only.
-- The hashed email (email_hash) already handles per-email rate limiting.
-- The plaintext column was only used for domain-burst detection — domain alone is enough.
-- Storing plaintext email of someone who never created an account is unnecessary PII retention.

ALTER TABLE free_samples ADD COLUMN email_domain TEXT;

-- Backfill: split email_plain on '@', take the trailing portion. SQLite's
-- substr + instr is enough.
UPDATE free_samples
SET email_domain = LOWER(SUBSTR(email_plain, INSTR(email_plain, '@') + 1))
WHERE email_plain IS NOT NULL AND INSTR(email_plain, '@') > 0;

ALTER TABLE free_samples DROP COLUMN email_plain;

CREATE INDEX idx_free_samples_domain_at ON free_samples(email_domain, used_at DESC);
