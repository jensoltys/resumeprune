-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Resume Prune authors. See LICENSE.
-- Lock-first webhook idempotency.
--
-- The existing `payment_events` table can't serve as a pre-flight lock because
-- its `user_id` column is NOT NULL, and we don't know the user until we've
-- dispatched the event. This dedicated dedup table is keyed ONLY on the Stripe
-- event id, so we can claim the lock as the FIRST thing the handler does:
--
--   INSERT OR IGNORE INTO webhook_events (stripe_event_id, ...) VALUES (...)
--
-- If `meta.changes === 0` the event id already existed → it's a concurrent or
-- replayed delivery → return 200 immediately WITHOUT re-running side effects.
-- Stripe's at-least-once delivery can fire the same event twice in parallel;
-- this closes the race window that the old "record-after-processing" order left
-- open. `payment_events` is still written (per-user audit log with amount).
CREATE TABLE webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
