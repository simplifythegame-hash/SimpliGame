import type { Game, GameEvent, LineupRow } from './types';

async function parseJson(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return data;
}

/** A fetch rejection means the request never reached the server (offline,
 *  DNS, dropped connection) — as opposed to an HTTP error, which parseJson
 *  turns into an Error above. */
function isNetworkFailure(err: unknown) {
  return err instanceof TypeError;
}

// ------------------------------------------- offline queue (stat events)
// When a stat-event POST fails because the device is offline, the event
// is stashed in localStorage and retried in order when the connection
// returns (on the 'online' event and on page load). The service worker
// never caches or replays mutations — this client-side queue is the one
// retry path, so events can't be sent twice by two mechanisms.
//
// Queue entries are the exact logEvent bodies; replay preserves order
// (a failed replay stops the drain so later events can't overtake it).
const QUEUE_KEY = 'simpligame:offline-queue';

type QueuedEvent = { gameId: string; body: { player_id: string | null; stat_type: string; side: 'ours' | 'opponent'; points: number; video_seconds: number } };

function readQueue(): QueuedEvent[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedEvent[]) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Storage full or unavailable — the event is lost rather than
    // crashing the app; the coach sees the error state.
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('simpligame:queue-changed', { detail: { count: queue.length } }),
    );
  }
}

function enqueueEvent(entry: QueuedEvent) {
  const queue = readQueue();
  queue.push(entry);
  writeQueue(queue);
}

async function drainQueue() {
  let queue = readQueue();
  while (queue.length > 0) {
    const [head, ...rest] = queue;
    try {
      const res = await fetch(`/api/games/${head.gameId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(head.body),
      });
      await parseJson(res);
      queue = rest;
      writeQueue(queue);
    } catch {
      // Still offline or the server rejected it — stop here to preserve
      // order; the next 'online' event retries.
      return;
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    void drainQueue();
  });
  // A reload after a crash or a closed tab retries anything still queued.
  void drainQueue();
}

export const api = {
  async getWorkspace() {
    const data = await parseJson(await fetch('/api/workspace'));
    return data as { organization: import('./types').Organization; teams: import('./types').Team[]; players: import('./types').Player[]; games: Game[]; events: GameEvent[]; lineups: LineupRow[] };
  },

  async createTeam(name: string, sport: string, season: string) {
    const data = await parseJson(
      await fetch('/api/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, sport, season }),
      }),
    );
    return data.team as import('./types').Team;
  },

  async addPlayer(teamId: string, name: string, jersey_number: string, position: string) {
    const data = await parseJson(
      await fetch(`/api/teams/${teamId}/players`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, jersey_number, position }),
      }),
    );
    return data.player as import('./types').Player;
  },

  async createGame(team_id: string, opponent: string, sport: string, mode: 'live' | 'film') {
    const data = await parseJson(
      await fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_id, opponent, sport, mode }),
      }),
    );
    return data.game as Game;
  },

  async getGame(gameId: string) {
    const data = await parseJson(await fetch(`/api/games/${gameId}`));
    return data as { game: Game; events: GameEvent[]; lineups: LineupRow[] };
  },

  async logEvent(
    gameId: string,
    body: { player_id: string | null; stat_type: string; side: 'ours' | 'opponent'; points: number; video_seconds: number },
  ) {
    try {
      const data = await parseJson(
        await fetch(`/api/games/${gameId}/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      return data.event as GameEvent;
    } catch (err) {
      // Offline: stash the event for automatic retry instead of losing
      // the stat. The caller checks `queued` and skips its refresh.
      if (isNetworkFailure(err)) {
        enqueueEvent({ gameId, body });
        return { queued: true } as { queued: true };
      }
      throw err;
    }
  },

  /** How many stat events are waiting to sync (0 when fully synced). */
  getQueuedEventCount() {
    return readQueue().length;
  },

  async setGameStatus(gameId: string, status: 'draft' | 'live' | 'final') {
    const data = await parseJson(
      await fetch(`/api/games/${gameId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      }),
    );
    return data.game as Game;
  },

  /** Set the starting 6 for a draft game (Start Live Game flow). */
  async setLineup(gameId: string, playerIds: string[]) {
    await parseJson(
      await fetch(`/api/games/${gameId}/lineup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_ids: playerIds }),
      }),
    );
  },

  async undo(gameId: string) {
    await parseJson(await fetch(`/api/games/${gameId}/undo`, { method: 'POST' }));
  },

  async renameOrganization(name: string) {
    const data = await parseJson(
      await fetch('/api/organization', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    );
    return data.organization as import('./types').Organization;
  },

  async sub(gameId: string, outPlayerId: string, inPlayerId: string) {
    const data = await parseJson(
      await fetch(`/api/games/${gameId}/sub`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outPlayerId, inPlayerId }),
      }),
    );
    return data.event as GameEvent;
  },

  async saveYouTube(gameId: string, url: string) {
    const data = await parseJson(
      await fetch(`/api/games/${gameId}/youtube`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      }),
    );
    return data.game as Game;
  },

  async publishGame(gameId: string) {
    const data = await parseJson(await fetch(`/api/games/${gameId}/publish`, { method: 'POST' }));
    return data as { game: Game; publicPath: string };
  },

  async unpublishGame(gameId: string) {
    const data = await parseJson(await fetch(`/api/games/${gameId}/unpublish`, { method: 'POST' }));
    return data.game as Game;
  },

  async revokeGameLink(gameId: string) {
    const data = await parseJson(await fetch(`/api/games/${gameId}/revoke`, { method: 'POST' }));
    return data as { game: Game; publicPath: string };
  },

  async getPublicWatch(token: string) {
    const data = await parseJson(await fetch(`/api/public/watch/${token}`));
    return data.watch as import('./types').PublicWatch;
  },

  async getPlayerProfile(playerId: string) {
    const data = await parseJson(await fetch(`/api/players/${playerId}/profile`));
    return data as {
      player: import('./types').Player;
      profile: import('./types').PlayerProfile | null;
      stats: import('./types').PlayerProfileStats;
    };
  },

  async updatePlayerProfile(
    playerId: string,
    body: { bio?: string; height?: string; graduation_year?: string; positions_text?: string; school?: string; club_team?: string },
  ) {
    const data = await parseJson(
      await fetch(`/api/players/${playerId}/profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return data.profile as import('./types').PlayerProfile;
  },

  async publishProfile(playerId: string) {
    const data = await parseJson(await fetch(`/api/players/${playerId}/profile/publish`, { method: 'POST' }));
    return data as { profile: import('./types').PlayerProfile; publicPath: string };
  },

  async unpublishProfile(playerId: string) {
    const data = await parseJson(await fetch(`/api/players/${playerId}/profile/unpublish`, { method: 'POST' }));
    return data.profile as import('./types').PlayerProfile;
  },

  async revokeProfileLink(playerId: string) {
    const data = await parseJson(await fetch(`/api/players/${playerId}/profile/revoke`, { method: 'POST' }));
    return data as { profile: import('./types').PlayerProfile; publicPath: string };
  },

  async getPublicProfile(token: string) {
    const data = await parseJson(await fetch(`/api/public/profile/${token}`));
    return data.profile as import('./types').PublicProfile;
  },

  async listReels() {
    const data = await parseJson(await fetch('/api/reels'));
    return data.reels as import('./types').ReelProject[];
  },

  async createReel(body: { name?: string; game_id?: string | null; clips?: import('./types').ReelClip[]; music_track?: string }) {
    const data = await parseJson(
      await fetch('/api/reels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return data.reel as import('./types').ReelProject;
  },

  async getReel(reelId: string) {
    const data = await parseJson(await fetch(`/api/reels/${reelId}`));
    return data.reel as import('./types').ReelProject;
  },

  async updateReel(
    reelId: string,
    body: { name?: string; clips?: import('./types').ReelClip[]; music_track?: string; status?: 'draft' | 'ready' },
  ) {
    const data = await parseJson(
      await fetch(`/api/reels/${reelId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return data.reel as import('./types').ReelProject;
  },

  async deleteReel(reelId: string) {
    await parseJson(await fetch(`/api/reels/${reelId}`, { method: 'DELETE' }));
  },

  async autoReel(gameId: string, preset: 'hype' | 'clean' | 'simple') {
    const data = await parseJson(
      await fetch('/api/reels/auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId, preset }),
      }),
    );
    return data.reel as import('./types').ReelProject;
  },

  async exportReel(reelId: string) {
    const data = await parseJson(await fetch(`/api/reels/${reelId}/export`, { method: 'POST' }));
    return data.export as { status: string; message: string };
  },

  async generateEnrollToken(playerId: string) {
    const data = await parseJson(await fetch(`/api/players/${playerId}/enroll-token`, { method: 'POST' }));
    return data as { enrollToken: string; publicPath: string };
  },

  async getPublicEnroll(token: string) {
    const data = await parseJson(await fetch(`/api/public/enroll/${token}`));
    return data.enroll as import('./types').EnrollInfo;
  },

  async submitEnroll(token: string, body: { phone: string; displayName?: string; optIn: boolean }) {
    const data = await parseJson(
      await fetch(`/api/public/enroll/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return data as { opted_in: boolean; masked_phone: string };
  },

  async getFamily(playerId: string) {
    const data = await parseJson(await fetch(`/api/players/${playerId}/family`));
    return data.contacts as import('./types').FamilyContact[];
  },

  async removeFamily(contactId: string) {
    await parseJson(await fetch(`/api/family/${contactId}`, { method: 'DELETE' }));
  },

  async getSmsLog(gameId: string) {
    const data = await parseJson(await fetch(`/api/games/${gameId}/sms-log`));
    return data.log as import('./types').SmsLogRow[];
  },

  async notifyHighlights(gameId: string) {
    const data = await parseJson(await fetch(`/api/games/${gameId}/notify-highlights`, { method: 'POST' }));
    return data as { attempted: number; sent: number; logged: number; failed: number };
  },

  async exportToSheets(gameId: string) {
    const data = await parseJson(await fetch(`/api/games/${gameId}/export-sheets`, { method: 'POST' }));
    return data as { notConfigured?: boolean; sheetId?: string; sheetUrl?: string };
  },

  async getSheetExports(gameId: string) {
    const data = await parseJson(await fetch(`/api/games/${gameId}/exports`));
    return data.exports as import('./types').SheetExport[];
  },

  async getAllSheetExports() {
    const data = await parseJson(await fetch(`/api/exports`));
    return data.exports as Array<
      import('./types').SheetExport & {
        opponent: string;
        status: string;
        our_score: number;
        opponent_score: number;
        team_name: string;
      }
    >;
  },

  async getAnalysis(gameId: string) {
    const data = await parseJson(await fetch(`/api/games/${gameId}/analysis`));
    return data as import('./types').GameAnalysis;
  },

  async verifyAnalysisSection(gameId: string, key: string, correction: string, note: string) {
    const data = await parseJson(
      await fetch(`/api/games/${gameId}/analysis/sections/${key}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ correction, note }),
      }),
    );
    return data as import('./types').GameAnalysis;
  },

  async unverifyAnalysisSection(gameId: string, key: string) {
    const data = await parseJson(
      await fetch(`/api/games/${gameId}/analysis/sections/${key}/unverify`, { method: 'POST' }),
    );
    return data as import('./types').GameAnalysis;
  },

  // ------------------------------------------- AI Vision Phase 1
  // Post-game AI Review Queue. The coach creates a job; the local
  // worker (owner's own machine) polls for it, processes the video
  // locally, and posts candidates back. The coach confirms each
  // candidate with one tap — nothing is published as AI-detected
  // without a human yes.
  async createAnalysisJob(gameId: string) {
    const data = await parseJson(await fetch(`/api/games/${gameId}/analysis-job`, { method: 'POST' }));
    return data as { job: import('./types').AnalysisJob; existed: boolean };
  },

  async getAnalysisJob(gameId: string) {
    const data = await parseJson(await fetch(`/api/games/${gameId}/analysis-job`));
    return data as {
      job: import('./types').AnalysisJob | null;
      candidates: import('./types').AnalysisCandidate[];
    };
  },

  async getAnalysisJobs() {
    const data = await parseJson(await fetch('/api/analysis/jobs'));
    return data.jobs as import('./types').AnalysisJob[];
  },

  async confirmCandidate(candidateId: string, body: { stat?: string; player_id?: string | null }) {
    const data = await parseJson(
      await fetch(`/api/analysis/candidates/${candidateId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return data as { event: import('./types').GameEvent; candidate: import('./types').AnalysisCandidate };
  },

  async skipCandidate(candidateId: string) {
    const data = await parseJson(
      await fetch(`/api/analysis/candidates/${candidateId}/skip`, { method: 'POST' }),
    );
    return data as { candidate: import('./types').AnalysisCandidate };
  },

  // ------------------------------------------- auth + coaches
  async getAuthStatus() {
    const data = await parseJson(await fetch('/api/auth/status'));
    return data as { usersExist: boolean; authUnavailable?: boolean };
  },

  /** Current session user, or user: null when not logged in (no throw). */
  async getMe() {
    const res = await fetch('/api/auth/me');
    if (res.status === 401) return { user: null, teamIds: [] as string[] };
    const data = await parseJson(res);
    return data as { user: import('./types').AuthUser; teamIds: string[] | null };
  },

  async login(email: string, password: string) {
    const data = await parseJson(
      await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      }),
    );
    return data.user as import('./types').AuthUser;
  },

  /** One-time owner bootstrap — works only when zero users exist. */
  async setup(name: string, email: string, password: string) {
    const data = await parseJson(
      await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      }),
    );
    return data.user as import('./types').AuthUser;
  },

  async logout() {
    await parseJson(await fetch('/api/auth/logout', { method: 'POST' }));
  },

  /** Self-service password change (verifies the current password). */
  async changePassword(currentPassword: string, newPassword: string) {
    await parseJson(
      await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      }),
    );
  },

  /** Update the signed-in user's own name/email (PATCH /api/auth/me —
   *  edits only their own record; the session stays alive). */
  async updateMe(name: string, email: string) {
    const data = await parseJson(
      await fetch('/api/auth/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email }),
      }),
    );
    return data.user as import('./types').AuthUser;
  },

  async listCoaches() {
    const data = await parseJson(await fetch('/api/coaches'));
    return data.coaches as import('./types').Coach[];
  },

  async createCoach(body: { name: string; email: string; password: string; role: string; teamIds: string[] }) {
    const data = await parseJson(
      await fetch('/api/coaches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return data.coach as import('./types').Coach;
  },

  async updateCoach(id: string, body: { name?: string; role?: string; teamIds?: string[] }) {
    const data = await parseJson(
      await fetch(`/api/coaches/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return data.coach as import('./types').Coach;
  },

  async deleteCoach(id: string) {
    await parseJson(await fetch(`/api/coaches/${id}`, { method: 'DELETE' }));
  },

  /** Owner-only: set a coach's password + invalidate all their sessions. */
  async resetCoachPassword(id: string, newPassword: string) {
    await parseJson(
      await fetch(`/api/coaches/${id}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword }),
      }),
    );
  },

  // ------------------------------------------- parent accounts (012)
  // Real parent logins: head coaches create/link them from a player's
  // profile; the parent's own reads come from /api/parent/home, scoped
  // server-side to their linked players.
  /** Parents visible to the caller, each with linked player IDs. */
  async listParents() {
    const data = await parseJson(await fetch('/api/parents'));
    return data.parents as import('./types').ParentAccount[];
  },

  /** Parents linked to one player (name + email only). */
  async getPlayerParents(playerId: string) {
    const data = await parseJson(await fetch(`/api/players/${playerId}/parents`));
    return data.parents as Array<Omit<import('./types').ParentAccount, 'playerIds'>>;
  },

  /** Create a parent account and link it to a player in one step. */
  async createParent(body: { name: string; email: string; password: string; player_id: string }) {
    const data = await parseJson(
      await fetch('/api/parents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return data.parent as import('./types').ParentAccount;
  },

  async linkParent(parentId: string, playerId: string) {
    await parseJson(
      await fetch(`/api/parents/${parentId}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_id: playerId }),
      }),
    );
  },

  async unlinkParent(parentId: string, playerId: string) {
    await parseJson(await fetch(`/api/parents/${parentId}/link/${playerId}`, { method: 'DELETE' }));
  },

  async deleteParent(parentId: string) {
    await parseJson(await fetch(`/api/parents/${parentId}`, { method: 'DELETE' }));
  },

  /** Head-coach reset for a managed parent + invalidate their sessions. */
  async resetParentPassword(parentId: string, newPassword: string) {
    await parseJson(
      await fetch(`/api/parents/${parentId}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword }),
      }),
    );
  },

  /** The signed-in parent's HOME payload (linked players only). */
  async getParentHome() {
    const data = await parseJson(await fetch('/api/parent/home'));
    return data as import('./types').ParentHome;
  },

  // ------------------------------------------- Google Drive import
  // Per-user Drive: imported videos live in the coach's OWN Drive
  // (drive.file scope). Connect is a full-page navigation to
  // /api/auth/google/connect (the server 302s to Google and back to
  // the app with a ?google= flag) — hence no api method for it.
  async getGoogleStatus() {
    const data = await parseJson(await fetch('/api/auth/google/status'));
    return data as import('./types').GoogleStatus;
  },

  async disconnectGoogle() {
    await parseJson(await fetch('/api/auth/google/disconnect', { method: 'POST' }));
  },

  /** Start an import: the server creates the library row and a Drive
   *  resumable upload session, and returns the session URL the browser
   *  uploads to directly (file bytes never pass through the server). */
  async initImportedUpload(body: { title: string; team_id?: string | null; mime_type: string; size_bytes: number }) {
    const data = await parseJson(
      await fetch('/api/imported-videos/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return data as { videoId: string; uploadUrl: string };
  },

  async completeImportedUpload(videoId: string, driveFileId: string | null) {
    const data = await parseJson(
      await fetch(`/api/imported-videos/${videoId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drive_file_id: driveFileId }),
      }),
    );
    return data.video as import('./types').ImportedVideo;
  },

  async listImportedVideos() {
    const data = await parseJson(await fetch('/api/imported-videos'));
    return data.videos as import('./types').ImportedVideo[];
  },

  async deleteImportedVideo(videoId: string) {
    await parseJson(await fetch(`/api/imported-videos/${videoId}`, { method: 'DELETE' }));
  },

  /** Short-lived Drive media URL (~1h) for HTML5 playback/seeking. */
  async getImportedMediaUrl(videoId: string) {
    const data = await parseJson(await fetch(`/api/imported-videos/${videoId}/media-url`));
    return data as { url: string; expiresInSeconds: number };
  },
};

/**
 * Upload a file to a Drive resumable session URL, in chunks, with
 * progress. The session URL is the capability (no auth header). Chunk
 * size must be a multiple of 256 KB per Drive's resumable protocol;
 * only the final chunk may be smaller. Resolves with the Drive file id
 * from the final response (or null when Google returns no body).
 * Rejects with a readable Error on any non-resume response.
 */
export function uploadFileToDriveSession(
  uploadUrl: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<{ driveFileId: string | null }> {
  const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB — a multiple of 256 KB.
  const total = file.size;

  function putChunk(start: number): Promise<{ driveFileId: string | null }> {
    if (start >= total) {
      return Promise.reject(new Error('Upload finished without a final response from Google.'));
    }
    const end = Math.min(start + CHUNK_SIZE, total);
    const chunk = file.slice(start, end);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('Content-Range', `bytes ${start}-${end - 1}/${total}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(Math.min(1, (start + e.loaded) / total));
        }
      };
      xhr.onerror = () => reject(new Error('Network error during upload — check your connection and retry.'));
      xhr.onabort = () => reject(new Error('Upload cancelled.'));
      xhr.onload = () => {
        if (xhr.status === 200 || xhr.status === 201) {
          let driveFileId: string | null = null;
          try {
            const parsed = JSON.parse(xhr.responseText) as { id?: string };
            driveFileId = typeof parsed.id === 'string' ? parsed.id : null;
          } catch {
            // No JSON body — /complete falls back to finding the file
            // by name in the SimpliGame folder.
          }
          onProgress(1);
          resolve({ driveFileId });
          return;
        }
        if (xhr.status === 308) {
          // Resume Incomplete: continue from where Google says it
          // stopped (Range header), or from the end of this chunk.
          const range = xhr.getResponseHeader('Range');
          const match = range ? range.match(/bytes=0-(\d+)/) : null;
          const next = match ? Number(match[1]) + 1 : end;
          onProgress(Math.min(1, next / total));
          resolve(putChunk(next));
          return;
        }
        reject(new Error(`Google upload failed (HTTP ${xhr.status}).`));
      };
      xhr.send(chunk);
    });
  }

  return putChunk(0);
}
