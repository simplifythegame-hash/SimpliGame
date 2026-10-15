-- SimpliGame — player profiles (003)
-- Per-player recruiting profiles: coach-editable bio + measurables,
-- plus the same unlisted token-only publish model as game watch links
-- (002). A profile is publicly visible only when profile_published =
-- true AND the caller presents the exact profile_token. No directory,
-- no search, no browsing: the public route serves ONLY the exact token,
-- and returns the same generic 404 for bad tokens, revoked tokens, and
-- unpublished profiles alike.
--
-- The owner runs this against the Neon database (Neon SQL Editor), then
-- restarts the Render service.

CREATE TABLE IF NOT EXISTS player_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id       UUID NOT NULL UNIQUE REFERENCES players (id) ON DELETE CASCADE,
  bio             TEXT NOT NULL DEFAULT '',
  height          TEXT NOT NULL DEFAULT '',
  graduation_year TEXT NOT NULL DEFAULT '',
  positions_text  TEXT NOT NULL DEFAULT '',
  school          TEXT NOT NULL DEFAULT '',
  club_team       TEXT NOT NULL DEFAULT '',
  profile_token   TEXT UNIQUE,
  profile_published BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_player_profiles_token ON player_profiles (profile_token);
