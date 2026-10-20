-- SimpliGame — imported videos (011)
-- Video Import: a library of YouTube videos imported BY LINK ONLY, for
-- footage that was not streamed in the app. Import is link-only by
-- design (the all-YouTube architecture): no file upload, no video
-- storage — a row stores only a title, the 11-character YouTube video
-- ID parsed from the pasted link, and an optional team.
--
-- Reel clips are JSONB inside reel_projects.clips (004) — there is NO
-- clips table to alter. Clips made from an imported video carry two
-- new OPTIONAL fields in that JSONB (importedVideoId + playerTag);
-- existing stored clips simply lack them, which the app reads as null.
-- That extension is code-only, so this migration changes no reel data.
--
-- The owner runs this against the Neon database (Neon SQL Editor), then
-- restarts the Render service.

CREATE TABLE IF NOT EXISTS imported_videos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  title            TEXT NOT NULL DEFAULT '',
  youtube_video_id TEXT NOT NULL,
  team_id          UUID REFERENCES teams (id) ON DELETE SET NULL,
  created_by       UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_imported_videos_org ON imported_videos (org_id);
CREATE INDEX IF NOT EXISTS idx_imported_videos_team ON imported_videos (team_id);
