-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Resume Prune authors. See LICENSE.
-- Email opt-outs (CAN-SPAM + GDPR right-to-object).
-- One row per email_hash that has opted out. Lookup is by hash so the table
-- doesn't store plaintext addresses. Account users also have their
-- users.newsletter_consent flipped to 0; this table catches the no-account
-- case (free-sample recipients) and acts as the source of truth for any
-- marketing-tinged send.

CREATE TABLE email_optouts (
  email_hash      TEXT PRIMARY KEY,
  opted_out_at    INTEGER NOT NULL,
  source          TEXT
);
CREATE INDEX idx_email_optouts_at ON email_optouts(opted_out_at DESC);
