-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Resume Prune authors. See LICENSE.
-- Stripe billing. Plan 3 — the launch gate.
-- users already has stripe_customer_id from migration 0001. Adding the
-- subscription-specific fields here.

ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE users ADD COLUMN stripe_status TEXT;
-- plan_expires already exists (INTEGER, epoch seconds). We bump it forward
-- whenever a webhook reports an active period, so Pro gating in usage.js
-- can short-circuit if plan_expires < now() even before the webhook fires.

-- Idempotent webhook log. UNIQUE on stripe_event_id is the dedupe lock:
-- if Stripe replays an event, INSERT OR IGNORE returns 0 changed rows and
-- the handler skips the side-effect.
CREATE TABLE payment_events (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_event_id TEXT UNIQUE NOT NULL,
  event_type      TEXT NOT NULL,
  amount          INTEGER,
  currency        TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_payment_events_user ON payment_events(user_id, created_at DESC);
