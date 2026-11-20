-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Resume Prune authors. See LICENSE.
-- Phase 6.2b — the hosted resume page becomes a human-facing artifact.
-- The public /r/:slug page is for people (recruiters clicking a link), not ATS
-- screeners, so it gets its own look: a chosen style, an accent color, an
-- optional headline, and custom links the person adds. The ATS PDF is unchanged
-- and rendered separately. (Profile photo is deferred — v1 uses an initials
-- monogram.)
--
-- style      : one of 'modern' | 'warm' | 'editorial' (validated in code)
-- accent     : hex color '#rrggbb' (validated in code before it ever hits CSS)
-- headline   : short tagline under the name (optional)
-- links_json : JSON array of {label, url} the person added (validated in code)

ALTER TABLE resume_pages ADD COLUMN style      TEXT NOT NULL DEFAULT 'modern';
ALTER TABLE resume_pages ADD COLUMN accent     TEXT NOT NULL DEFAULT '#4f46e5';
ALTER TABLE resume_pages ADD COLUMN headline   TEXT;
ALTER TABLE resume_pages ADD COLUMN links_json TEXT;
