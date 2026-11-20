-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Resume Prune authors. See LICENSE.
-- Resume Prune initial schema
-- Plan 1 covers users, free_samples, email_tokens, feedback, rate_limits.
-- resumes, tweaks, usage_counters, payment_events come in plans 2 and 3.

CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT UNIQUE NOT NULL,
  pw_hash         TEXT NOT NULL,
  plan            TEXT NOT NULL DEFAULT 'free',
  plan_expires    INTEGER,
  stripe_customer_id TEXT,
  newsletter_consent INTEGER NOT NULL DEFAULT 0,
  newsletter_consent_at INTEGER,
  target_role     TEXT,
  target_industry TEXT,
  email_verified  INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_users_email ON users(email);

-- Single-use tokens for email verification + password reset
CREATE TABLE email_tokens (
  token_hash      TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose         TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_email_tokens_user ON email_tokens(user_id);

-- Free sample rate limiting + lead capture
CREATE TABLE free_samples (
  id              TEXT PRIMARY KEY,
  email_hash      TEXT NOT NULL,
  email_plain     TEXT NOT NULL,
  ip_hash         TEXT NOT NULL,
  used_at         INTEGER NOT NULL,
  newsletter_consent INTEGER NOT NULL DEFAULT 0,
  newsletter_consent_at INTEGER
);
CREATE INDEX idx_free_email ON free_samples(email_hash, used_at DESC);
CREATE INDEX idx_free_ip ON free_samples(ip_hash, used_at DESC);

-- Generic rate limit window storage (D1-backed)
CREATE TABLE rate_limits (
  key             TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  PRIMARY KEY (key, ts)
);
CREATE INDEX idx_rate_limits_key_ts ON rate_limits(key, ts);

-- Feedback widget
CREATE TABLE feedback (
  id              TEXT PRIMARY KEY,
  uid             TEXT,
  page            TEXT,
  message         TEXT NOT NULL,
  user_agent      TEXT,
  created_at      INTEGER NOT NULL
);
