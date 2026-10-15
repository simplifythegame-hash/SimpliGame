-- SimpliGame — Google Sheets export (007)
-- Records every Sheet a coach exports a game to, so Game Detail can
-- list past exports with links. The export itself is built from the
-- game's real events/box score — no invented stats.
--
-- The owner runs this against the Neon database (Neon SQL Editor), then
-- restarts the Render service.

CREATE TABLE IF NOT EXISTS sheet_exports (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id    UUID NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  sheet_id   TEXT NOT NULL,
  sheet_url  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sheet_exports_game ON sheet_exports (game_id);
