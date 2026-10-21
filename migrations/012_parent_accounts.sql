-- SimpliGame — real parent accounts (012)
-- Postgres, Neon-compatible. Plain SQL, no extensions required.
--
-- Parents get REAL logins (the owner chose this over token links).
-- A parent is a user with role 'parent', created by a head coach from
-- the player's profile (Player Management → Parents), and linked to
-- one or more players via parent_players — their kids. A parent sees
-- ONLY their linked players: their profile/stats, their team's
-- published games (watch access), and their own Drive imports. They
-- hold NONE of the coach permissions — the role ranks below stat_crew
-- in the permission matrix, so every coach action 403s server-side.
--
-- Drive import ties in here: a parent may import video ONLY for a
-- team one of their linked players plays on, and the import lands in
-- that team's library (owner = the parent) where coaches find it in
-- Highlight Builder / Reel Studio like any other import.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('owner', 'head_coach', 'assistant', 'stat_crew', 'parent'));

CREATE TABLE IF NOT EXISTS parent_players (
  user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  player_id  UUID NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_parent_players_user ON parent_players (user_id);
CREATE INDEX IF NOT EXISTS idx_parent_players_player ON parent_players (player_id);
