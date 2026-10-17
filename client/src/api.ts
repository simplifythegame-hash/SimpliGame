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
};
