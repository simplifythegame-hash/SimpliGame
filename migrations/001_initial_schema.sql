-- SimpliGame — initial schema (001)
-- Postgres, Neon-compatible. Plain SQL, no extensions required.
-- Owner-scoped by design: v1 is a single-owner app. All rows belong to
-- the one organization; there is no cross-org logic yet. When multi-org
-- auth lands, every query must additionally scope by the caller's org.

CREATE TABLE IF NOT EXISTS organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  primary_color   TEXT NOT NULL DEFAULT '#04BEF1',
  secondary_color TEXT NOT NULL DEFAULT '#048DF1',
  logo_url    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS teams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sport       TEXT NOT NULL DEFAULT 'Volleyball',
  season      TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS players (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id       UUID NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  jersey_number TEXT NOT NULL DEFAULT '',
  position      TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS games (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         UUID NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  opponent        TEXT NOT NULL DEFAULT '',
  sport           TEXT NOT NULL DEFAULT 'Volleyball',
  mode            TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'film')),
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'final')),
  youtube_video_id TEXT,
  our_score       INTEGER NOT NULL DEFAULT 0,
  opponent_score  INTEGER NOT NULL DEFAULT 0,
  period_label    TEXT NOT NULL DEFAULT 'Set 1',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS game_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id       UUID NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  player_id     UUID REFERENCES players (id) ON DELETE SET NULL,
  stat_type     TEXT NOT NULL,
  side          TEXT NOT NULL DEFAULT 'ours' CHECK (side IN ('ours', 'opponent')),
  points        INTEGER NOT NULL DEFAULT 0,
  video_seconds INTEGER NOT NULL DEFAULT 0,
  entry_method  TEXT NOT NULL DEFAULT 'live' CHECK (entry_method IN ('live', 'film', 'assisted')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lineups (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id   UUID NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  slot      INTEGER NOT NULL,
  UNIQUE (game_id, slot),
  UNIQUE (game_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_teams_org ON teams (org_id);
CREATE INDEX IF NOT EXISTS idx_players_team ON players (team_id);
CREATE INDEX IF NOT EXISTS idx_games_team ON games (team_id);
CREATE INDEX IF NOT EXISTS idx_events_game ON game_events (game_id);
CREATE INDEX IF NOT EXISTS idx_lineups_game ON lineups (game_id);
