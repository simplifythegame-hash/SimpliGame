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
  publish_token: string | null;
  published: boolean;
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

/** Public watch payload: ONLY the published game's surface. No rosters,
 *  no other games, no org details, no internal IDs. */
export interface PublicWatchEvent {
  player_name: string | null;
  jersey_number: string | null;
  stat_type: string;
  side: 'ours' | 'opponent';
  points: number;
  created_at: string;
}

export interface PublicWatchBoxRow {
  name: string;
  jersey_number: string;
  points: number;
  stats: Record<string, number>;
}

export interface PublicWatch {
  team_name: string;
  opponent: string;
  sport: string;
  mode: string;
  status: string;
  period_label: string;
  our_score: number;
  opponent_score: number;
  youtube_video_id: string | null;
  events: PublicWatchEvent[];
  boxScore: PublicWatchBoxRow[];
}

/** Recruiting profile: coach-editable bio + measurables, publish token
 *  (coach-side only — never exposed on the public payload). */
export interface PlayerProfile {
  id: string;
  player_id: string;
  bio: string;
  height: string;
  graduation_year: string;
  positions_text: string;
  school: string;
  club_team: string;
  profile_token: string | null;
  profile_published: boolean;
}

/** Auto-aggregated stats: career totals by stat type, per-game breakdown,
 *  and highlight events with video links. */
export interface PlayerProfileStats {
  totals: Record<string, number>;
  totalPoints: number;
  gamesPlayed: number;
  byGame: { opponent: string; date: string; stats: Record<string, number>; points: number }[];
  highlights: {
    stat_type: string;
    points: number;
    video_seconds: number;
    created_at: string;
    opponent: string;
    youtube_video_id: string | null;
  }[];
}

/** Reel Studio: one clip in a reel project. startSeconds/endSeconds are
 *  trim offsets into the clip's video. Music is a placeholder track name
 *  only — no real audio in this round. */
export interface ReelClip {
  eventId: string | null;
  gameId: string | null;
  videoId: string | null;
  startSeconds: number;
  endSeconds: number;
  transition: 'cut' | 'fade';
  overlay: string;
  slowMo: boolean;
}

/** Reel project: ordered clips + music + status. Export is a mock in
 *  this build — real MP4 rendering is a later production build. */
export interface ReelProject {
  id: string;
  org_id: string;
  game_id: string | null;
  name: string;
  clips: ReelClip[];
  music_track: string;
  status: 'draft' | 'ready';
  created_at: string;
  updated_at: string;
}

/** Public profile payload: ONLY this player's surface. No roster,
 *  no other players, no org details, no internal IDs. */
export interface PublicProfile {
  name: string;
  jersey_number: string;
  position: string;
  team_name: string;
  bio: string;
  height: string;
  graduation_year: string;
  positions_text: string;
  school: string;
  club_team: string;
  stats: PlayerProfileStats;
}
