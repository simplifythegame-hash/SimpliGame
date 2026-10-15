-- SimpliGame — reel projects (004)
-- Reel Studio + Auto Reel: highlight-reel projects that persist
-- server-side. A project is an ordered list of clips (stored as JSONB),
-- each clip pointing at a game event with its video timestamp, plus
-- trim offsets, a transition, a text overlay, and a slow-motion flag.
-- Music is a placeholder track name only — there are no real audio
-- files and no audio playback in this round (same honesty as the
-- prototype: export is a mock; real MP4 rendering is a later
-- production build).
--
-- The owner runs this against the Neon database (Neon SQL Editor), then
-- restarts the Render service.

CREATE TABLE IF NOT EXISTS reel_projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  game_id     UUID REFERENCES games (id) ON DELETE SET NULL,
  name        TEXT NOT NULL DEFAULT 'Untitled reel',
  clips       JSONB NOT NULL DEFAULT '[]'::jsonb,
  music_track TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reel_projects_org ON reel_projects (org_id);
CREATE INDEX IF NOT EXISTS idx_reel_projects_game ON reel_projects (game_id);
