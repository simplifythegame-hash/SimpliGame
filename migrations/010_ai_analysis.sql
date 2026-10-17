-- SimpliGame — AI Vision Phase 1: AI Review Queue (010)
-- Postgres, Neon-compatible. Plain SQL, no extensions required.
--
-- AI Vision Phase 1 is post-game ONLY and human-in-the-loop: the
-- coach's own machine (the local worker, worker/analyze.py) polls for
-- pending jobs, downloads the game's video itself, runs the local
-- model (our own weights, trained on our own footage), and POSTs
-- candidate events back. The server stores jobs + candidates and
-- serves the Review Queue. NO inference runs on the server (Render
-- has no GPU) and footage is never uploaded anywhere — the worker
-- processes it locally and deletes it.
--
-- analysis_jobs: one row per analysis run. One active (pending /
-- processing) job per game; a finished game can be re-analyzed after
-- the previous job is done/failed (a new row).
-- analysis_candidates: one proposed event per AI suggestion.
-- timestamp_sec is the moment in the video; clip_start/end bound the
-- 6-second clip the coach reviews. proposed_stat / proposed_player_id
-- are the model's suggestion; final_stat / final_player_id record what
-- the coach actually confirmed (NULL until reviewed). status:
-- pending → confirmed | corrected | skipped. Confirmed/corrected
-- candidates become NORMAL game_events via the existing event
-- pipeline (score, box score, totals all follow) — the candidate row
-- itself never counts as a stat.

CREATE TABLE IF NOT EXISTS analysis_jobs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id    UUID NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analysis_candidates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             UUID NOT NULL REFERENCES analysis_jobs (id) ON DELETE CASCADE,
  game_id            UUID NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  timestamp_sec      REAL NOT NULL,
  clip_start_sec     REAL NOT NULL,
  clip_end_sec       REAL NOT NULL,
  proposed_stat      TEXT NOT NULL,
  proposed_player_id UUID REFERENCES players (id) ON DELETE SET NULL,
  confidence         REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'confirmed', 'corrected', 'skipped')),
  final_stat         TEXT,
  final_player_id    UUID REFERENCES players (id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_analysis_jobs_game ON analysis_jobs (game_id);
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_status ON analysis_jobs (status);
CREATE INDEX IF NOT EXISTS idx_analysis_candidates_job ON analysis_candidates (job_id);
CREATE INDEX IF NOT EXISTS idx_analysis_candidates_game ON analysis_candidates (game_id);
CREATE INDEX IF NOT EXISTS idx_analysis_candidates_status ON analysis_candidates (status);
