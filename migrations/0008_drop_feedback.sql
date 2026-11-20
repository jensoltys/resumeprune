-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Resume Prune authors. See LICENSE.
-- Drop unused `feedback` D1 table.
-- The feedback widget at public/shared/feedback-widget.js posts to an n8n
-- webhook (a feedback webhook), not to the Worker.
-- The D1 feedback table was created in migration 0001 but has never been
-- written to from this app. Dropping removes the dormant table that lacked
-- an FK to users and would never get cascade-deleted on account-delete.

DROP INDEX IF EXISTS idx_feedback_uid;
DROP TABLE IF EXISTS feedback;
