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
};
