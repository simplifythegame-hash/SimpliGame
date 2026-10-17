// Assisted post-game analysis — rule-based overview + human sign-off.
//
// The overview is pure computation from the game's real recorded data
// (game record, events, roster). NO AI provider is involved, and no
// number is ever invented: missing data is reported as Missing, and
// anything derived from an incomplete event log is labeled Estimated.
//
// Each section carries a confidence derived from the data itself:
//   high      — the underlying facts are closed/complete (e.g. the
//               game is final, so the recorded score will not change)
//   estimated — derived from a live/incomplete log; treat as a draft
//               until the coach verifies it
//   missing   — there is no data to compute this section from
//
// A coach reviews each section and signs it off (Verified, optionally
// with a correction/note). Only Verified sections count as official.
// The review state (not the overview) is what persists in game_analysis.

export type AnalysisConfidence = 'high' | 'estimated' | 'missing';

export interface AnalysisSection {
  key: string;
  title: string;
  confidence: AnalysisConfidence;
  /** One-line computed summary, or "Missing" when there is no data. */
  summary: string;
  /** Supporting computed facts (empty when missing). */
  detail: string[];
  verified: boolean;
  correction: string | null;
  note: string | null;
  verified_at: string | null;
}

export interface StoredSectionReview {
  verified: boolean;
  correction: string | null;
  note: string | null;
  verified_at: string | null;
}

export type AnalysisOverallStatus = 'unreviewed' | 'partially verified' | 'verified';

export const ANALYSIS_SECTION_KEYS = ['score', 'totals', 'leaders', 'moments', 'completeness'] as const;
export type AnalysisSectionKey = (typeof ANALYSIS_SECTION_KEYS)[number];

const SECTION_TITLES: Record<AnalysisSectionKey, string> = {
  score: 'Final score',
  totals: 'Stat totals',
  leaders: 'Top contributors',
  moments: 'Key moments',
  completeness: 'Completeness',
};

interface OverviewInput {
  game: {
    status: string;
    our_score: number;
    opponent_score: number;
    youtube_video_id: string | null;
  };
  events: {
    player_id: string | null;
    stat_type: string;
    side: 'ours' | 'opponent';
    points: number;
    entry_method: string;
    created_at: string;
  }[];
  players: { id: string; name: string; jersey_number: string }[];
}

/** A game with very few events was not live-tagged — its totals are
 *  necessarily incomplete. 10 is a deliberately low bar: a single
 *  volleyball set has dozens of rallies, so anything under 10 means
 *  only a fragment of the game was recorded. */
const MIN_EVENTS_FOR_PLAUSIBLE_LOG = 10;

function formatPlayer(players: OverviewInput['players'], playerId: string | null): string {
  const p = players.find((x) => x.id === playerId);
  return p ? `${p.name} (#${p.jersey_number})` : 'Unknown player';
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

/**
 * Generate the overview from the game's real data. Every number comes
 * from the event log or the game record; nothing is estimated, filled
 * in, or guessed.
 */
export function generateOverview(input: OverviewInput): Omit<AnalysisSection, 'verified' | 'correction' | 'note' | 'verified_at'>[] {
  const { game, events, players } = input;
  const isFinal = game.status === 'final';
  const sections: Omit<AnalysisSection, 'verified' | 'correction' | 'note' | 'verified_at'>[] = [];

  // --- Score: straight from the game record (kept in lockstep with the
  // event log by the server). High confidence only once the game is final.
  sections.push({
    key: 'score',
    title: SECTION_TITLES.score,
    confidence: isFinal ? 'high' : 'estimated',
    summary: `Us ${game.our_score} — Them ${game.opponent_score}`,
    detail: isFinal
      ? ['Game status is final — the recorded score will not change.']
      : [`Game status is ${game.status} — the score may still change.`],
  });

  // --- Totals: counts by stat type across the whole event log.
  if (events.length === 0) {
    sections.push({
      key: 'totals',
      title: SECTION_TITLES.totals,
      confidence: 'missing',
      summary: 'Missing — no events were recorded for this game.',
      detail: [],
    });
  } else {
    const byType = new Map<string, number>();
    for (const e of events) byType.set(e.stat_type, (byType.get(e.stat_type) ?? 0) + 1);
    const detail = [...byType.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([stat, count]) => `${stat}: ${count}`);
    const thin = events.length < MIN_EVENTS_FOR_PLAUSIBLE_LOG;
    sections.push({
      key: 'totals',
      title: SECTION_TITLES.totals,
      confidence: 'estimated',
      summary: `${events.length} event${events.length === 1 ? '' : 's'} recorded.`,
      detail: thin
        ? [
            `Only ${events.length} events were recorded — far below a full game. These totals are incomplete; they count only what was tagged.`,
            ...detail,
          ]
        : ['Totals count only what was tagged in this game.', ...detail],
    });
  }

  // --- Leaders: per-player points + most frequent stat type.
  const playerEvents = events.filter((e) => e.player_id);
  if (playerEvents.length === 0) {
    sections.push({
      key: 'leaders',
      title: SECTION_TITLES.leaders,
      confidence: 'missing',
      summary: 'Missing — no player-attributed events were recorded.',
      detail: [],
    });
  } else {
    const byPlayer = new Map<string, { points: number; stats: Map<string, number> }>();
    for (const e of playerEvents) {
      const entry = byPlayer.get(e.player_id as string) ?? { points: 0, stats: new Map() };
      // Our-side points only — an opponent-side point (e.g. our Serve
      // Error) is the opponent's point, not this player's.
      if (e.side === 'ours') {
        entry.points += e.points;
      }
      entry.stats.set(e.stat_type, (entry.stats.get(e.stat_type) ?? 0) + 1);
      byPlayer.set(e.player_id as string, entry);
    }
    const ranked = [...byPlayer.entries()].sort((a, b) => b[1].points - a[1].points);
    const top = ranked[0];
    const topStat = [...top[1].stats.entries()].sort((a, b) => b[1] - a[1])[0];
    sections.push({
      key: 'leaders',
      title: SECTION_TITLES.leaders,
      confidence: 'estimated',
      summary: `Top scorer: ${formatPlayer(players, top[0])} — ${top[1].points} point${top[1].points === 1 ? '' : 's'} (${topStat[0]}: ${topStat[1]}).`,
      detail: ranked.slice(0, 5).map(([pid, entry]) => {
        const best = [...entry.stats.entries()].sort((a, b) => b[1] - a[1])[0];
        return `${formatPlayer(players, pid)}: ${entry.points} pts — most frequent: ${best[0]} (${best[1]})`;
      }),
    });
  }

  // --- Moments: first score, largest scoring run, final event.
  if (events.length === 0) {
    sections.push({
      key: 'moments',
      title: SECTION_TITLES.moments,
      confidence: 'missing',
      summary: 'Missing — no events were recorded for this game.',
      detail: [],
    });
  } else {
    const detail: string[] = [];
    const firstScore = events.find((e) => e.points > 0);
    if (firstScore) {
      const who =
        firstScore.side === 'ours'
          ? formatPlayer(players, firstScore.player_id)
          : 'Opponent';
      detail.push(`First score: ${who} — ${firstScore.stat_type} (+${firstScore.points}) at ${formatTime(firstScore.created_at)}.`);
    } else {
      detail.push('No scoring event was recorded.');
    }
    // Largest run of consecutive scoring events by one side.
    let bestRun = { side: '', length: 0, points: 0 };
    let runSide = '';
    let runLength = 0;
    let runPoints = 0;
    for (const e of events) {
      if (e.points <= 0) continue;
      if (e.side === runSide) {
        runLength += 1;
        runPoints += e.points;
      } else {
        runSide = e.side;
        runLength = 1;
        runPoints = e.points;
      }
      if (runLength > bestRun.length) bestRun = { side: runSide, length: runLength, points: runPoints };
    }
    if (bestRun.length > 0) {
      detail.push(
        `Largest scoring run: ${bestRun.side === 'ours' ? 'Us' : 'Them'} — ${bestRun.length} consecutive scoring event${bestRun.length === 1 ? '' : 's'} for ${bestRun.points} point${bestRun.points === 1 ? '' : 's'}.`,
      );
    }
    const last = events[events.length - 1];
    detail.push(
      `Final recorded event: ${last.side === 'ours' ? formatPlayer(players, last.player_id) : 'Opponent'} — ${last.stat_type} at ${formatTime(last.created_at)}.`,
    );
    sections.push({
      key: 'moments',
      title: SECTION_TITLES.moments,
      confidence: 'estimated',
      summary: firstScore
        ? `First score at ${formatTime(firstScore.created_at)}; largest run ${bestRun.length}.`
        : 'No scoring event was recorded.',
      detail,
    });
  }

  // --- Completeness: the meta-assessment — how much of the game was
  // actually captured. Every fact here is exact from the record.
  const liveTagged = events.filter((e) => e.entry_method === 'live').length;
  const detail = [
    `${events.length} event${events.length === 1 ? '' : 's'} recorded (${liveTagged} tagged live, ${events.length - liveTagged} from other entry methods).`,
    game.youtube_video_id ? 'Video attached — timeline jumps available.' : 'No video attached — no video timestamps for these events.',
  ];
  if (events.length === 0) {
    detail.push('Nothing was recorded for this game: no score, totals, or moments can be trusted until events are tagged.');
  } else if (events.length < MIN_EVENTS_FOR_PLAUSIBLE_LOG) {
    detail.push('Event log looks incomplete — this game was probably not live-tagged end to end.');
  }
  sections.push({
    key: 'completeness',
    title: SECTION_TITLES.completeness,
    confidence: isFinal ? 'high' : 'estimated',
    summary:
      events.length === 0
        ? 'No data recorded.'
        : `${events.length} events · ${game.youtube_video_id ? 'video attached' : 'no video'}.`,
    detail,
  });

  return sections;
}

/** Merge a stored review onto a freshly generated overview. */
export function applyReview(
  overview: Omit<AnalysisSection, 'verified' | 'correction' | 'note' | 'verified_at'>[],
  stored: Record<string, StoredSectionReview>,
): AnalysisSection[] {
  return overview.map((section) => {
    const review = stored[section.key];
    return {
      ...section,
      verified: review?.verified ?? false,
      correction: review?.correction ?? null,
      note: review?.note ?? null,
      verified_at: review?.verified_at ?? null,
    };
  });
}

/** Overall status from the merged sections: all verified → verified,
 *  some → partially verified, none → unreviewed. */
export function deriveOverallStatus(sections: AnalysisSection[]): AnalysisOverallStatus {
  if (sections.length === 0) return 'unreviewed';
  const verified = sections.filter((s) => s.verified).length;
  if (verified === sections.length) return 'verified';
  if (verified > 0) return 'partially verified';
  return 'unreviewed';
}

export function isAnalysisSectionKey(key: string): key is AnalysisSectionKey {
  return (ANALYSIS_SECTION_KEYS as readonly string[]).includes(key);
}
