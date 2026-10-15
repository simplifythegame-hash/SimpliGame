import type { Game, GameEvent, LineupRow } from './types';

async function parseJson(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return data;
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
    const data = await parseJson(
      await fetch(`/api/games/${gameId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return data.event as GameEvent;
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
};
