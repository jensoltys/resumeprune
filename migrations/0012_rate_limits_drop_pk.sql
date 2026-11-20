-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Resume Prune authors. See LICENSE.
-- 0012: drop the (key, ts) PRIMARY KEY on rate_limits.
--
-- ts is whole seconds, so two same-key requests in the same second violated
-- the PK; the SQLITE_CONSTRAINT error escaped rateLimit() and the whole route
-- returned 500 — including the guest-checkout money path (a visitor double-
-- clicking a plan CTA hit it). Found by the paid-products sweep 2026-07-04.
--
-- Every hit is now its own row, which also makes burst counting accurate
-- (the PK silently deduped same-second hits before).
CREATE TABLE rate_limits_new (
  key             TEXT NOT NULL,
  ts              INTEGER NOT NULL
);
INSERT INTO rate_limits_new (key, ts) SELECT key, ts FROM rate_limits;
DROP TABLE rate_limits;
ALTER TABLE rate_limits_new RENAME TO rate_limits;
CREATE INDEX idx_rate_limits_key_ts ON rate_limits(key, ts);
