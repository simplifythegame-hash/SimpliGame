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
  // Unlisted family-enrollment link token (coach-side only — the public
  // enroll page shows only the player's first name + team name).
  enroll_token: string | null;
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
  // Set only on Substitution events (migration 005): the player who went
  // out, so undo can reverse the lineup swap. Null on all other events
  // and on subs recorded before 005.
  out_player_id: string | null;
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

/** AI Vision Phase 1: one analysis run for a finished game. The
 *  local worker polls for pending jobs, processes the video on the
 *  owner's own machine, and POSTs candidates back. */
export interface AnalysisJob {
  id: string;
  game_id: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** One AI-proposed event. proposed_* is the model's suggestion;
 *  final_* records what the coach actually confirmed (null until
 *  reviewed). A confirmed/corrected candidate becomes a normal
 *  game_event — the candidate row itself never counts as a stat. */
export interface AnalysisCandidate {
  id: string;
  job_id: string;
  game_id: string;
  timestamp_sec: number;
  clip_start_sec: number;
  clip_end_sec: number;
  proposed_stat: string;
  proposed_player_id: string | null;
  confidence: number;
  status: 'pending' | 'confirmed' | 'corrected' | 'skipped';
  final_stat: string | null;
  final_player_id: string | null;
  created_at: string;
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
  /** Org brand colors — the public page wears the club's colors. */
  primary_color: string;
  secondary_color: string;
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
 *  trim offsets into the clip's video. A clip draws from exactly one
 *  source: a YouTube video (videoId — game highlights) or an imported
 *  Drive video (importedVideoId). playerTag is a label only, used for
 *  overlays on imported clips. Music is a placeholder track name
 *  only — no real audio in this round. */
export interface ReelClip {
  eventId: string | null;
  gameId: string | null;
  videoId: string | null;
  importedVideoId: string | null;
  playerTag: string | null;
  startSeconds: number;
  endSeconds: number;
  transition: 'cut' | 'fade';
  overlay: string;
  slowMo: boolean;
}

/** A video imported into the uploader's OWN Google Drive (drive.file
 *  scope — the file lives in their Drive, tied to them). ready=false
 *  means the upload never completed; those rows are only visible to
 *  their owner. Playback goes through a short-lived media URL, never
 *  a raw Drive id. */
export interface ImportedVideo {
  id: string;
  title: string;
  team_id: string | null;
  mime_type: string;
  size_bytes: number;
  ready: boolean;
  owner_user_id: string;
  mine: boolean;
  created_at: string;
}

/** Per-user Google Drive connection status. email is the connected
 *  Google account's address (display only) — never a token. */
export interface GoogleStatus {
  connected: boolean;
  email: string | null;
  setupRequired?: boolean;
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

/** Family enrollment: coach-side contact — MASKED number only. The
 *  full number never appears in any API response. */
export interface FamilyContact {
  id: string;
  player_id: string;
  masked_phone: string;
  display_name: string;
  opted_in: boolean;
  created_at: string;
}

/** SMS delivery log row — masked number only. */
export interface SmsLogRow {
  id: string;
  game_id: string | null;
  message_type: 'go_live' | 'highlights';
  status: 'sent' | 'logged' | 'failed';
  masked_phone: string | null;
  provider_sid: string | null;
  error: string | null;
  created_at: string;
}

/** Google Sheets export record — a real Sheet link, never a fake. */
export interface SheetExport {
  id: string;
  game_id: string;
  sheet_id: string;
  sheet_url: string;
  created_at: string;
}

/** Assisted post-game analysis: one overview section, computed from
 *  the game's real recorded data (never AI, never invented).
 *  confidence: high = closed/complete facts, estimated = derived from
 *  an incomplete log, missing = no data to compute from. */
export interface AnalysisSection {
  key: string;
  title: string;
  confidence: 'high' | 'estimated' | 'missing';
  summary: string;
  detail: string[];
  verified: boolean;
  correction: string | null;
  note: string | null;
  verified_at: string | null;
}

/** Full analysis payload: freshly computed overview + stored review. */
export interface GameAnalysis {
  game_id: string;
  overall_status: 'unreviewed' | 'partially verified' | 'verified';
  sections: AnalysisSection[];
}

/** Public enroll page payload: ONLY the player's first name + team. */
export interface EnrollInfo {
  player_first_name: string;
  team_name: string;
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
  /** Org brand colors — the public page wears the club's colors. */
  primary_color: string;
  secondary_color: string;
}

/** Logged-in user: owner sees all teams; coaches see assigned teams.
 *  Never includes a password hash. */
export type CoachRole = 'owner' | 'head_coach' | 'assistant' | 'stat_crew';

export interface AuthUser {
  id: string;
  org_id: string;
  email: string;
  name: string;
  role: CoachRole;
  created_at: string | null;
}

/** A coach account (owner-only view): role + assigned team IDs. */
export interface Coach extends AuthUser {
  teamIds: string[];
}
