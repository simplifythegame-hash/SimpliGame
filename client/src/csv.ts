import type { Game, GameEvent, Player } from './types';

/**
 * Shared CSV export — the same builder Game Detail uses, so the
 * Export Center's per-game CSVs and Game Detail's CSV are identical.
 * A real CSV built client-side from the game's own data, so export
 * always works — with or without Google configured. Columns mirror
 * the Google Sheets tabs (Box Score, Timeline).
 */

type CsvEvent = {
  player_id: string | null;
  stat_type: string;
  points: number;
  side: string;
  created_at: string;
  video_seconds: number;
};

function csvEscape(value: string | number): string {
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function buildGameCsv(
  game: Game,
  players: Player[],
  events: CsvEvent[] | GameEvent[],
): string {
  const byPlayer = new Map<string, { name: string; stats: Record<string, number>; points: number }>();
  for (const e of events) {
    if (!e.player_id) continue;
    const player = players.find((p) => p.id === e.player_id);
    const entry = byPlayer.get(e.player_id) ?? { name: player?.name ?? 'Unknown', stats: {}, points: 0 };
    entry.stats[e.stat_type] = (entry.stats[e.stat_type] ?? 0) + 1;
    entry.points += e.points;
    byPlayer.set(e.player_id, entry);
  }
  const boxScore = [...byPlayer.values()];

  const statTypes = [...new Set(events.map((e) => e.stat_type))].sort();
  const lines: string[] = [];
  lines.push('Box Score');
  lines.push(['Player', 'Jersey', 'Points', ...statTypes].map(csvEscape).join(','));
  for (const row of boxScore) {
    const player = players.find((p) => p.name === row.name);
    lines.push(
      [row.name, player?.jersey_number ?? '', row.points, ...statTypes.map((t) => row.stats[t] ?? 0)]
        .map(csvEscape)
        .join(','),
    );
  }
  lines.push('');
  lines.push('Timeline');
  lines.push(['Time', 'Player', 'Stat', 'Side', 'Points', 'Video'].map(csvEscape).join(','));
  for (const e of events) {
    const player = players.find((p) => p.id === e.player_id);
    lines.push(
      [
        new Date(e.created_at).toLocaleString(),
        player?.name ?? (e.side === 'opponent' ? 'Opponent' : 'Team'),
        e.stat_type,
        e.side,
        e.points,
        formatTimestamp(e.video_seconds),
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return lines.join('\r\n');
}

export function downloadGameCsv(game: Game, players: Player[], events: CsvEvent[] | GameEvent[]): void {
  const blob = new Blob([buildGameCsv(game, players, events)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `simpligame-${game.opponent || 'game'}-${game.id.slice(0, 8)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
