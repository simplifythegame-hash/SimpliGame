-- SimpliGame — Google Drive video import (011)
-- Postgres, Neon-compatible. Plain SQL, no extensions required.
--
-- Imported videos live in EACH USER'S OWN Google Drive (tied to them,
-- not the app owner). Per-user Drive connection: the coach connects
-- their own Google account once (Account screen → Connect Google
-- Drive, drive.file scope only — the app can only touch files it
-- created). The browser uploads the file straight to Google via a
-- server-initiated resumable upload session; files never pass through
-- Render. Reel Studio cuts clips from imported videos via short-lived
-- Drive media URLs (see GET /api/imported-videos/:id/media-url).
--
-- users.google_refresh_token / google_email: the per-user Drive
-- connection. The refresh token is a credential: it is NEVER returned
-- by any API response and never logged. (Separate identity from the
-- app-level Sheets OAuth refresh token in the env vars — that one is
-- the app's own export account.)
--
-- imported_videos: one row per import. drive_file_id is NULL until
-- the upload completes (the browser reports the id from Drive's final
-- response; the server verifies it with files.get). ready=false rows
-- are incomplete uploads — shown only to their owner, with a Delete.

ALTER TABLE users ADD COLUMN IF NOT EXISTS google_refresh_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_email TEXT;

CREATE TABLE IF NOT EXISTS imported_videos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  drive_file_id TEXT,
  team_id       UUID REFERENCES teams (id) ON DELETE SET NULL,
  mime_type     TEXT NOT NULL DEFAULT '',
  size_bytes    BIGINT NOT NULL DEFAULT 0,
  ready         BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_imported_videos_org ON imported_videos (org_id);
CREATE INDEX IF NOT EXISTS idx_imported_videos_owner ON imported_videos (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_imported_videos_team ON imported_videos (team_id);
