-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Resume Prune authors. See LICENSE.
-- Job-hunt tracker: where the application behind each tweak stands.
-- Values: tweaked (default) -> applied -> interviewing -> offer; closed = no
-- longer pursuing (rejected / withdrawn / filled). Enforced in tweak-routes.
ALTER TABLE tweaks ADD COLUMN app_status TEXT NOT NULL DEFAULT 'tweaked';
