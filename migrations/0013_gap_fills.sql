-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Resume Prune authors. See LICENSE.
-- 0013: gap fills — user-confirmed experience that wasn't on the base resume.
-- When the match analysis lists a gap, a paid user can save a chunk of real
-- experience that covers it. Saved fills persist on the account and feed every
-- future analyze/tailor/cover call as candidate-supplied truth.
CREATE TABLE gap_fills (
  id              TEXT PRIMARY KEY,
  uid             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gap             TEXT NOT NULL,   -- the JD gap this addresses (short phrase)
  body            TEXT NOT NULL,   -- the user's own account of the experience
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_gap_fills_uid ON gap_fills(uid);
