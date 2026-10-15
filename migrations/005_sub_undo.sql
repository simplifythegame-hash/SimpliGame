-- SimpliGame — sub undo (005)
-- A Substitution event now records which player went OUT, so undo can
-- reverse a lineup swap instead of only deleting the timeline row.
-- Subs recorded before this migration have out_player_id NULL; undoing
-- one of those falls back to the old behavior (delete the event, leave
-- the lineup as-is) rather than failing.
--
-- The owner runs this against the Neon database (Neon SQL Editor), then
-- restarts the Render service.

ALTER TABLE game_events ADD COLUMN IF NOT EXISTS out_player_id UUID REFERENCES players (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_events_out_player ON game_events (out_player_id);
