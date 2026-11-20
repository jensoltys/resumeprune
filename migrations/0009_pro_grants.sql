-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Resume Prune authors. See LICENSE.
-- Affiliate Pro gifts: a time-boxed Pro grant (e.g. 6 months) applied directly
-- to a user's account, with NO Stripe subscription. Keyed by email so a gift can
-- be issued before the affiliate has a Resume Prune account; it lands on their
-- next login/verify. Real paid subscriptions are unaffected (they keep flowing
-- through Stripe + webhooks). Access expires via plan_expires for gifted users,
-- so a 6-month gift reverts to free at month 6. Times are epoch seconds to match
-- users.plan_expires.
CREATE TABLE IF NOT EXISTS pro_grants (
  email      TEXT PRIMARY KEY,
  plan_expires INTEGER NOT NULL,
  source     TEXT,
  created_at INTEGER NOT NULL,
  applied_at INTEGER
);
