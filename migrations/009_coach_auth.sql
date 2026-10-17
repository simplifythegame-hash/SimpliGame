-- SimpliGame — coach logins + team-scoped permissions (009)
-- Postgres, Neon-compatible. Plain SQL, no extensions required.
--
-- users: one row per login. email is unique per org. role is one of
-- owner / head_coach / assistant / stat_crew. Passwords are stored as
-- scrypt hashes only — never plaintext, never logged.
-- sessions: opaque session tokens, stored only as SHA-256 hashes.
-- coach_teams: which teams a non-owner coach may see. Owners (teamIds
-- null in code) see every team; a coach with no rows sees no teams.

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'assistant'
                CHECK (role IN ('owner', 'head_coach', 'assistant', 'stat_crew')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);

CREATE TABLE IF NOT EXISTS sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coach_teams (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, team_id)
);

CREATE INDEX IF NOT EXISTS idx_users_org ON users (org_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_coach_teams_user ON coach_teams (user_id);
CREATE INDEX IF NOT EXISTS idx_coach_teams_team ON coach_teams (team_id);
