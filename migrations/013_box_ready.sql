-- SimpliGame — box readiness: storage seam + render-job queue (013)
-- Postgres, Neon-compatible. Plain SQL, no extensions required.
--
-- This migration builds NO user-facing feature. It lays the two data
-- seams the independence roadmap needs so the app can move onto the
-- owner's own mini-PC (and grow its roadmap features) without another
-- schema scramble:
--
-- 1) STORAGE SEAM on imported_videos.
--    storage_provider names the ONE place an import's file lives:
--      'drive' — the uploader's own Google Drive (today; the only
--                implemented provider). File identity = drive_file_id.
--      's3'    — an S3-compatible bucket (MinIO on the owner's box;
--                Phase 2). File identity will be storage_key.
--    Every existing row is 'drive' by construction (the column lands
--    with that default and backfills), and the server's playback
--    minting (server/src/storage.ts) branches on this column through
--    a single function — 's3' currently answers a clear
--    not-implemented error. storage_key stays NULL for drive rows.
--
-- 2) RENDER-JOB QUEUE (render_jobs) — DATA ONLY.
--    An export is a clip list, and any renderer can consume it: the
--    job's payload (JSONB) is that clip list — the sources, each
--    clip's in/out points, and its overlays — in one engine-agnostic
--    shape. Browser ffmpeg, the Dell worker, a worker on the box, or
--    a future managed renderer all read the SAME payload and write
--    back status + result_url; the app does not care which engine
--    ran. kind distinguishes a full reel render ('reel', reel_id
--    set) from a single highlight clip ('clip', game_id set).
--    NO endpoints or UI read or write this table yet — the schema
--    lands now so the Phase 3 build is pure code, not migration.

ALTER TABLE imported_videos
  ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 'drive';

DO $$
BEGIN
  ALTER TABLE imported_videos
    ADD CONSTRAINT imported_videos_storage_provider_check
    CHECK (storage_provider IN ('drive', 's3'));
EXCEPTION
  WHEN duplicate_object THEN NULL; -- constraint already added
END $$;

ALTER TABLE imported_videos
  ADD COLUMN IF NOT EXISTS storage_key TEXT;

-- Backfill (defensive: the ADD COLUMN default already fills existing
-- rows on Postgres 11+; this covers any row that somehow holds NULL).
UPDATE imported_videos SET storage_provider = 'drive' WHERE storage_provider IS NULL;

CREATE TABLE IF NOT EXISTS render_jobs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  reel_id    UUID REFERENCES reel_projects (id) ON DELETE CASCADE,
  game_id    UUID REFERENCES games (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('reel', 'clip')),
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  status     TEXT NOT NULL DEFAULT 'queued'
             CHECK (status IN ('queued', 'rendering', 'done', 'failed')),
  result_url TEXT,
  error      TEXT,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_render_jobs_org ON render_jobs (org_id);
CREATE INDEX IF NOT EXISTS idx_render_jobs_status ON render_jobs (status);
CREATE INDEX IF NOT EXISTS idx_render_jobs_reel ON render_jobs (reel_id);
CREATE INDEX IF NOT EXISTS idx_render_jobs_game ON render_jobs (game_id);
