-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Resume Prune authors. See LICENSE.
-- Add token_version (tv) for JWT revocation.
-- Bumped on password change / reset / explicit logout-all so existing JWTs
-- (which embed the value at issue time) become invalid immediately.
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
