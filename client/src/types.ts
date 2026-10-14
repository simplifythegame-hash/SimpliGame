export interface Organization {
  id: string;
  name: string;
  primary_color: string;
  secondary_color: string;
  logo_url: string | null;
}

export interface Team {
  id: string;
  org_id: string;
  name: string;
  sport: string;
  season: string;
}

export interface Player {
  id: string;
  team_id: string;
  name: string;
  jersey_number: string;
  position: string;
}

export interface Game {
  id: string;
  team_id: string;
  opponent: string;
  sport: string;
  mode: 'live' | 'film';
  status: 'draft' | 'live' | 'final';
  youtube_video_id: string | null;
  our_score: number;
  opponent_score: number;
  period_label: string;
}

export interface GameEvent {
  id: string;
  game_id: string;
  player_id: string | null;
  stat_type: string;
  side: 'ours' | 'opponent';
  points: number;
  video_seconds: number;
  entry_method: string;
  created_at: string;
}

export interface LineupRow {
  id: string;
  game_id: string;
  player_id: string;
  slot: number;
}

export interface Workspace {
  organization: Organization;
  teams: Team[];
  players: Player[];
  games: Game[];
  events: GameEvent[];
  lineups: LineupRow[];
}
