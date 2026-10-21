import type { Pool } from 'pg';
import { refreshDriveAccessToken } from './drive';

// ------------------------------------------------------------------
// Imported-video storage seam (box-readiness, migration 013).
//
// Every imported video lives in exactly ONE storage provider, named
// by imported_videos.storage_provider:
//   'drive' — the uploader's own Google Drive (today; the only
//             implemented provider). The file's identity is
//             imported_videos.drive_file_id.
//   's3'    — an S3-compatible bucket (MinIO on the owner's own box;
//             Phase 2 of the independence roadmap). The object's
//             identity will be imported_videos.storage_key.
//
// Playback URLs are minted HERE and nowhere else, branching on the
// provider, so the day 's3' lands, only this file changes: callers
// (today just GET /api/imported-videos/:id/media-url) already speak
// in provider-neutral results. Until then, an 's3' row gets a clear
// not-implemented error — never a fake URL.
// ------------------------------------------------------------------

export type StorageProvider = 'drive' | 's3';

/** The provider for an imported_videos row. Rows predate migration
 *  013 (no column selected / NULL) are 'drive' — every import before
 *  the seam existed lives in a user's Drive by construction. */
export function storageProviderOf(row: { storage_provider?: unknown }): StorageProvider {
  return row.storage_provider === 's3' ? 's3' : 'drive';
}

/** Load a user's stored Drive refresh token. Returns null when the
 *  user never connected (or disconnected) Google Drive. */
async function loadDriveRefreshToken(db: Pool, userId: string): Promise<string | null> {
  const row = await db.query('SELECT google_refresh_token FROM users WHERE id = $1', [userId]);
  const token = row.rows[0]?.google_refresh_token as string | null | undefined;
  return typeof token === 'string' && token ? token : null;
}

/** A fresh Drive access token for a user, or null when they are not
 *  connected or Google refuses the grant. */
export async function freshDriveAccessToken(db: Pool, userId: string): Promise<string | null> {
  const refreshToken = await loadDriveRefreshToken(db, userId);
  if (!refreshToken) return null;
  return refreshDriveAccessToken(refreshToken);
}

export type MintedMediaUrl =
  | { ok: true; url: string; expiresInSeconds: number }
  | { ok: false; status: number; error: string };

/** Mint a short-lived playback URL for an imported video, branching
 *  on its storage provider. This is the ONLY place playback URLs are
 *  created. */
export async function mintImportedVideoMediaUrl(
  db: Pool,
  row: { storage_provider?: unknown; drive_file_id?: unknown; owner_user_id?: unknown },
): Promise<MintedMediaUrl> {
  const provider = storageProviderOf(row);

  if (provider === 's3') {
    // Not implemented yet — 's3' rows cannot exist until the MinIO
    // import path is built (Phase 2). Honest error, never a fake URL.
    return {
      ok: false,
      status: 501,
      error:
        'This video is stored in SimpliGame box storage (S3), which is not enabled yet — playback for box-stored imports is still being built.',
    };
  }

  // provider === 'drive'
  if (typeof row.drive_file_id !== 'string' || !row.drive_file_id) {
    return { ok: false, status: 400, error: 'This import has no Drive file yet.' };
  }
  // HONEST NOTE: the URL carries the VIDEO OWNER's Drive access
  // token, not the caller's — an imported video plays for the org's
  // coaches through the app record, by design (the owner imported it
  // for the team). The token is short-lived (~1 hour), scoped to
  // drive.file (only files SimpliGame created in the owner's Drive),
  // and the URL is minted fresh per request for a signed-in coach who
  // can already see the video in the library. Drive supports Range
  // requests on media downloads, so the <video> element can seek for
  // clip cutting.
  const ownerToken = await freshDriveAccessToken(db, row.owner_user_id as string);
  if (!ownerToken) {
    return {
      ok: false,
      status: 400,
      error: 'The video owner has disconnected Google Drive — this import cannot play right now.',
    };
  }
  return {
    ok: true,
    url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(row.drive_file_id)}?alt=media&access_token=${encodeURIComponent(ownerToken)}`,
    expiresInSeconds: 3600,
  };
}
