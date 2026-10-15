-- SimpliGame — family SMS (006)
-- Families SELF-ENROLL their own phone numbers via an unlisted enroll
-- link per player — the coach never types in anyone's number. Coach
-- views show MASKED numbers only; full numbers never appear in any API
-- response. The watch link goes out the moment the coach taps Go Live.
-- Real sending uses Twilio; with no Twilio credentials the app runs in
-- log-only mode (every attempt recorded as 'logged', never claimed sent).
--
-- The owner runs this against the Neon database (Neon SQL Editor), then
-- restarts the Render service.

ALTER TABLE players ADD COLUMN IF NOT EXISTS enroll_token TEXT UNIQUE;

CREATE TABLE IF NOT EXISTS family_contacts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id    UUID NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  phone_e164   TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  opted_in    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (player_id, phone_e164)
);

CREATE INDEX IF NOT EXISTS idx_family_contacts_player ON family_contacts (player_id);

CREATE TABLE IF NOT EXISTS sms_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id      UUID REFERENCES games (id) ON DELETE SET NULL,
  contact_id   UUID REFERENCES family_contacts (id) ON DELETE SET NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('go_live', 'highlights')),
  status       TEXT NOT NULL CHECK (status IN ('sent', 'logged', 'failed')),
  provider_sid TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_log_game ON sms_log (game_id);
