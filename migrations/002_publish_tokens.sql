-- SimpliGame — publish tokens (002)
-- Unlisted, token-only public watch links. A game is publicly visible
-- only when published = true AND the caller presents the exact token.
-- No directory, no search, no browsing: the public route serves ONLY the
-- exact token, and returns the same generic 404 for bad tokens, revoked
-- tokens, and unpublished games alike.
--
-- The owner runs this against the Neon database (Neon SQL Editor), then
-- restarts the Render service.

ALTER TABLE games ADD COLUMN IF NOT EXISTS publish_token TEXT UNIQUE;
ALTER TABLE games ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_games_publish_token ON games (publish_token);
