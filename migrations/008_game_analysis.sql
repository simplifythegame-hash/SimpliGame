-- SimpliGame — assisted post-game analysis (008)
-- Stores the human review state for the auto-generated post-game
-- overview. The overview itself is NEVER stored: it is recomputed from
-- the game's real events on every read, so it can never go stale.
-- Only the coach's per-section sign-off (verified flag, correction,
-- note, timestamp) lives here.
--
-- The owner runs this against the Neon database (Neon SQL Editor), then
-- restarts the Render service.

CREATE TABLE IF NOT EXISTS game_analysis (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id       UUID NOT NULL UNIQUE REFERENCES games (id) ON DELETE CASCADE,
  -- { "<section key>": { verified, correction, note, verified_at } }
  sections      JSONB NOT NULL DEFAULT '{}'::jsonb,
  overall_status TEXT NOT NULL DEFAULT 'unreviewed',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_game_analysis_game ON game_analysis (game_id);
