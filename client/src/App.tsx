import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type { Game, Player, PublicWatch, Workspace } from './types';
import YouTubePlayer from './components/YouTubePlayer';
import './styles.css';

/** Stat buttons for the live screen. Points follow volleyball scoring:
 *  Kill / Ace / Block win the rally; everything else is tracked at 0. */
const STAT_BUTTONS: { label: string; points: number }[] = [
  { label: 'Kill', points: 1 },
  { label: 'Ace', points: 1 },
  { label: 'Block', points: 1 },
  { label: 'Dig', points: 0 },
  { label: 'Assist', points: 0 },
  { label: 'Attack attempt', points: 0 },
  { label: 'Serve', points: 0 },
  { label: 'Error', points: 0 },
];

type View = { kind: 'home' } | { kind: 'live'; gameId: string } | { kind: 'detail'; gameId: string };

export default function App() {
  // Public watch route: /watch/<token> renders the standalone watch page
  // INSTEAD of the app shell — no nav, no login, no editing, and no
  // workspace fetch. The pathname never changes during a page load, so
  // this early return is stable across renders.
  const watchMatch =
    typeof window !== 'undefined' ? window.location.pathname.match(/^\/watch\/([^/]+)$/) : null;
  if (watchMatch) {
    return <WatchPage token={watchMatch[1]} />;
  }

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [view, setView] = useState<View>({ kind: 'home' });
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(true);

  const [teamName, setTeamName] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [playerJersey, setPlayerJersey] = useState('');
  const [playerPosition, setPlayerPosition] = useState('');
  const [opponent, setOpponent] = useState('');
  const [mode, setMode] = useState<'live' | 'film'>('live');
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [editingOrg, setEditingOrg] = useState(false);
  const [orgName, setOrgName] = useState('');

  const refresh = useCallback(async () => {
    const ws = await api.getWorkspace();
    setWorkspace(ws);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh().catch((e) => {
      setError(e instanceof Error ? e.message : 'Failed to load workspace');
      setLoading(false);
    });
  }, [refresh]);

  const selectedTeam = workspace?.teams.find((t) => t.id === selectedTeamId);
  const roster = useMemo(
    () => workspace?.players.filter((p) => p.team_id === selectedTeamId) ?? [],
    [workspace, selectedTeamId],
  );
  const currentGame =
    view.kind !== 'home' ? workspace?.games.find((g) => g.id === view.gameId) : undefined;

  async function run(action: () => Promise<void>) {
    setError('');
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  }

  async function handleCreateTeam(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => {
      const team = await api.createTeam(teamName, 'Volleyball', '');
      setTeamName('');
      setSelectedTeamId(team.id);
    });
  }

  async function handleAddPlayer(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedTeamId) return;
    await run(async () => {
      await api.addPlayer(selectedTeamId, playerName, playerJersey, playerPosition);
      setPlayerName('');
      setPlayerJersey('');
      setPlayerPosition('');
    });
  }

  async function handleCreateGame(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedTeamId) return;
    await run(async () => {
      const game = await api.createGame(selectedTeamId, opponent, 'Volleyball', mode);
      setOpponent('');
      setView({ kind: 'live', gameId: game.id });
    });
  }

  async function handleLogEvent(stat: { label: string; points: number }) {
    if (!currentGame || !selectedPlayerId) return;
    await run(async () => {
      await api.logEvent(currentGame.id, {
        player_id: selectedPlayerId,
        stat_type: stat.label,
        side: 'ours',
        points: stat.points,
        video_seconds: 0,
      });
    });
  }

  async function handleOpponentScores() {
    if (!currentGame) return;
    await run(async () => {
      await api.logEvent(currentGame.id, {
        player_id: null,
        stat_type: 'Opponent point',
        side: 'opponent',
        points: 1,
        video_seconds: 0,
      });
    });
  }

  if (loading) return <div className="page"><p>Loading SimpliGame…</p></div>;
  if (!workspace) return <div className="page"><p className="error">{error || 'Could not load workspace.'}</p></div>;

  const org = workspace.organization;

  return (
    <div className="page" style={{ ['--brand' as string]: org.primary_color, ['--brand2' as string]: org.secondary_color }}>
      <header className="org-header">
        {editingOrg ? (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await api.renameOrganization(orgName);
                setEditingOrg(false);
              });
            }}
          >
            <input
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="Organization name"
              maxLength={100}
              required
              autoFocus
            />
            <button type="submit">Save</button>
            <button type="button" onClick={() => setEditingOrg(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <h1>
            {org.name}{' '}
            <button
              className="org-edit-btn"
              aria-label="Rename organization"
              onClick={() => {
                setOrgName(org.name);
                setEditingOrg(true);
              }}
            >
              ✏️
            </button>
          </h1>
        )}
        <p className="tagline">SimpliGame — Simplify the Game</p>
      </header>

      {error && <p className="error">{error}</p>}

      {view.kind === 'home' && (
        <>
          <section>
            <h2>Teams</h2>
            <form onSubmit={handleCreateTeam} className="row">
              <input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="New team name" required />
              <button type="submit">Create team</button>
            </form>
            <ul className="list">
              {workspace.teams.map((t) => (
                <li key={t.id}>
                  <button className={t.id === selectedTeamId ? 'selected' : ''} onClick={() => setSelectedTeamId(t.id)}>
                    {t.name} ({t.sport})
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {selectedTeam && (
            <section>
              <h2>Roster — {selectedTeam.name}</h2>
              <form onSubmit={handleAddPlayer} className="row">
                <input value={playerName} onChange={(e) => setPlayerName(e.target.value)} placeholder="Player name" required />
                <input value={playerJersey} onChange={(e) => setPlayerJersey(e.target.value)} placeholder="#" />
                <input value={playerPosition} onChange={(e) => setPlayerPosition(e.target.value)} placeholder="Position" />
                <button type="submit">Add player</button>
              </form>
              <ul className="list">
                {roster.map((p) => (
                  <li key={p.id}>
                    #{p.jersey_number} {p.name} — {p.position}
                  </li>
                ))}
              </ul>

              <h3>New game</h3>
              <form onSubmit={handleCreateGame} className="row">
                <input value={opponent} onChange={(e) => setOpponent(e.target.value)} placeholder="Opponent" />
                <select value={mode} onChange={(e) => setMode(e.target.value as 'live' | 'film')}>
                  <option value="live">Live game</option>
                  <option value="film">Film review</option>
                </select>
                <button type="submit">Create game</button>
              </form>
            </section>
          )}

          <section>
            <h2>Games</h2>
            <ul className="list">
              {workspace.games.map((g) => {
                const team = workspace.teams.find((t) => t.id === g.team_id);
                return (
                  <li key={g.id}>
                    {team?.name ?? 'Team'} vs {g.opponent || 'TBD'} — {g.our_score}:{g.opponent_score} ({g.mode})
                    {' '}
                    <button onClick={() => setView({ kind: 'live', gameId: g.id })}>Live</button>{' '}
                    <button onClick={() => setView({ kind: 'detail', gameId: g.id })}>Detail</button>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}

      {view.kind === 'live' && currentGame && (
        <LiveGameScreen
          game={currentGame}
          players={workspace.players.filter((p) => p.team_id === currentGame.team_id)}
          lineupPlayerIds={workspace.lineups.filter((l) => l.game_id === currentGame.id).map((l) => l.player_id)}
          events={workspace.events.filter((e) => e.game_id === currentGame.id)}
          selectedPlayerId={selectedPlayerId}
          onSelectPlayer={setSelectedPlayerId}
          onLogEvent={handleLogEvent}
          onOpponentScores={handleOpponentScores}
          onUndo={async () => run(() => api.undo(currentGame.id))}
          onSub={async (outPlayerId, inPlayerId) => {
            await run(async () => {
              await api.sub(currentGame.id, outPlayerId, inPlayerId);
            });
            // The tagged player may now be on the bench — clear the
            // selection so stats can't be tagged to a benched player.
            setSelectedPlayerId(null);
          }}
          onBack={() => setView({ kind: 'home' })}
          onDetail={() => setView({ kind: 'detail', gameId: currentGame.id })}
        />
      )}

      {view.kind === 'detail' && currentGame && (
        <GameDetailScreen
          game={currentGame}
          players={workspace.players.filter((p) => p.team_id === currentGame.team_id)}
          events={workspace.events.filter((e) => e.game_id === currentGame.id)}
          youtubeUrl={youtubeUrl}
          onYoutubeUrlChange={setYoutubeUrl}
          onSaveYouTube={async () => {
            await run(async () => {
              await api.saveYouTube(currentGame.id, youtubeUrl);
              setYoutubeUrl('');
            });
          }}
          onPublish={async () => {
            await run(async () => {
              await api.publishGame(currentGame.id);
            });
          }}
          onUnpublish={async () => {
            await run(async () => {
              await api.unpublishGame(currentGame.id);
            });
          }}
          onRevoke={async () => {
            await run(async () => {
              await api.revokeGameLink(currentGame.id);
            });
          }}
          onBack={() => setView({ kind: 'home' })}
          onLive={() => setView({ kind: 'live', gameId: currentGame.id })}
        />
      )}
    </div>
  );
}

function LiveGameScreen(props: {
  game: Game;
  players: Player[];
  lineupPlayerIds: string[];
  events: { player_id: string | null; stat_type: string; points: number; side: string }[];
  selectedPlayerId: string | null;
  onSelectPlayer: (id: string) => void;
  onLogEvent: (stat: { label: string; points: number }) => void;
  onOpponentScores: () => void;
  onUndo: () => void;
  onSub: (outPlayerId: string, inPlayerId: string) => Promise<void>;
  onBack: () => void;
  onDetail: () => void;
}) {
  // On-court lineup: saved lineup rows if present, else the first 6 roster
  // players (the server seeds lineup rows at game creation).
  const onCourt = props.lineupPlayerIds.length > 0
    ? props.lineupPlayerIds.map((id) => props.players.find((p) => p.id === id)).filter((p): p is Player => !!p)
    : props.players.slice(0, 6);
  const onCourtIds = new Set(onCourt.map((p) => p.id));
  // Bench: everyone on the roster who is not currently on the court.
  const bench = props.players.filter((p) => !onCourtIds.has(p.id));
  const selected = props.players.find((p) => p.id === props.selectedPlayerId);

  // Sub flow state: tap Sub, tap the on-court player going out, tap the
  // bench player coming in, confirm. The lineup itself always comes from
  // the server (workspace.lineups), so a refresh keeps the current lineup.
  const [subMode, setSubMode] = useState(false);
  const [subOut, setSubOut] = useState<string | null>(null);
  const [subIn, setSubIn] = useState<string | null>(null);

  function exitSubMode() {
    setSubMode(false);
    setSubOut(null);
    setSubIn(null);
  }

  async function confirmSub() {
    if (!subOut || !subIn) return;
    await props.onSub(subOut, subIn);
    exitSubMode();
  }

  const subOutPlayer = props.players.find((p) => p.id === subOut);
  const subInPlayer = props.players.find((p) => p.id === subIn);

  return (
    <section>
      <button onClick={props.onBack}>← All games</button>{' '}
      <button onClick={props.onDetail}>Game detail</button>
      <h2>
        Live — vs {props.game.opponent || 'TBD'} · {props.game.period_label}
      </h2>
      <p className="score">
        Us {props.game.our_score} — {props.game.opponent_score} Them
      </p>

      <h3>On court — tap a player, then tap a stat</h3>
      <div className="cards">
        {onCourt.map((p) => (
          <button
            key={p.id}
            className={`card ${subMode ? (p.id === subOut ? 'selected' : '') : p.id === props.selectedPlayerId ? 'selected' : ''}`}
            onClick={() => {
              if (subMode) {
                // In sub mode, on-court taps pick the player going out.
                setSubOut(subOut === p.id ? null : p.id);
              } else {
                props.onSelectPlayer(p.id);
              }
            }}
          >
            <strong>#{p.jersey_number}</strong>
            <br />
            {p.name}
            <br />
            <small>{p.position}</small>
          </button>
        ))}
      </div>
      {onCourt.length === 0 && <p>No players on the roster yet — add players first.</p>}

      <div className="row">
        {!subMode ? (
          <button onClick={() => setSubMode(true)}>Sub</button>
        ) : (
          <>
            <span className="sub-hint">Tap the player going out, then the bench player coming in.</span>
            <button disabled={!subOut || !subIn} onClick={confirmSub}>
              Confirm sub
            </button>
            <button onClick={exitSubMode}>Cancel</button>
          </>
        )}
      </div>
      {subMode && (
        <p>
          Out: <strong>{subOutPlayer?.name ?? '—'}</strong> · In: <strong>{subInPlayer?.name ?? '—'}</strong>
        </p>
      )}

      {!subMode && selected && (
        <>
          <p>
            Tagging: <strong>{selected.name}</strong>
          </p>
          <div className="row">
            {STAT_BUTTONS.map((s) => (
              <button key={s.label} onClick={() => props.onLogEvent(s)}>
                {s.label}
                {s.points > 0 ? ` (+${s.points})` : ''}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="row">
        <button onClick={props.onOpponentScores}>Opponent scores (+1)</button>
        <button onClick={props.onUndo}>Undo last event</button>
      </div>

      <h3>Bench</h3>
      {bench.length === 0 ? (
        <p>No bench players.</p>
      ) : (
        <ul className="list">
          {bench.map((p) => (
            <li key={p.id}>
              {subMode ? (
                <button
                  className={p.id === subIn ? 'selected' : ''}
                  onClick={() => setSubIn(subIn === p.id ? null : p.id)}
                >
                  #{p.jersey_number} {p.name} — {p.position}
                </button>
              ) : (
                <>
                  #{p.jersey_number} {p.name} — {p.position}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3>Recent events</h3>
      <ul className="list">
        {[...props.events].reverse().slice(0, 10).map((e, i) => (
          <li key={i}>
            {e.stat_type} {e.points > 0 ? `(+${e.points})` : ''} — {e.side}
          </li>
        ))}
      </ul>
    </section>
  );
}

function GameDetailScreen(props: {
  game: Game;
  players: Player[];
  events: { player_id: string | null; stat_type: string; points: number; side: string; created_at: string }[];
  youtubeUrl: string;
  onYoutubeUrlChange: (v: string) => void;
  onSaveYouTube: () => void;
  onPublish: () => void;
  onUnpublish: () => void;
  onRevoke: () => void;
  onBack: () => void;
  onLive: () => void;
}) {
  // Box score: per-player counts by stat type, plus points.
  const [copied, setCopied] = useState(false);
  const boxScore = useMemo(() => {
    const byPlayer = new Map<string, { name: string; stats: Record<string, number>; points: number }>();
    for (const e of props.events) {
      if (!e.player_id) continue;
      const player = props.players.find((p) => p.id === e.player_id);
      const entry = byPlayer.get(e.player_id) ?? { name: player?.name ?? 'Unknown', stats: {}, points: 0 };
      entry.stats[e.stat_type] = (entry.stats[e.stat_type] ?? 0) + 1;
      entry.points += e.points;
      byPlayer.set(e.player_id, entry);
    }
    return [...byPlayer.values()];
  }, [props.events, props.players]);

  return (
    <section>
      <button onClick={props.onBack}>← All games</button>{' '}
      <button onClick={props.onLive}>Live screen</button>
      <h2>
        Game detail — vs {props.game.opponent || 'TBD'} · Final {props.game.our_score}:{props.game.opponent_score}
      </h2>

      <h3>Video</h3>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          props.onSaveYouTube();
        }}
      >
        <input
          value={props.youtubeUrl}
          onChange={(e) => props.onYoutubeUrlChange(e.target.value)}
          placeholder="Paste YouTube link or video ID"
          className="wide"
        />
        <button type="submit">Save video</button>
      </form>
      {props.game.youtube_video_id ? (
        <YouTubePlayer videoId={props.game.youtube_video_id} isLive={props.game.status === 'live'} />
      ) : (
        <p>No video attached yet.</p>
      )}

      <h3>Watch link</h3>
      {props.game.published && props.game.publish_token ? (
        <>
          <p>Published — anyone with the link can watch this game live. No login needed.</p>
          <div className="row">
            <input
              readOnly
              value={`${window.location.origin}/watch/${props.game.publish_token}`}
              className="wide"
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    `${window.location.origin}/watch/${props.game.publish_token}`,
                  );
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  // Clipboard unavailable — the input above is selected on
                  // focus, so the coach can copy it manually.
                }
              }}
            >
              {copied ? 'Copied!' : 'Copy link'}
            </button>
          </div>
          <div className="row">
            <button onClick={props.onUnpublish}>Unpublish</button>
            <button onClick={props.onRevoke}>Regenerate link</button>
          </div>
          <p>
            <small>Regenerating the link kills the old one — anyone with the old link can no longer watch.</small>
          </p>
        </>
      ) : (
        <>
          <p>Not published — the watch link only works after you publish this game.</p>
          <button onClick={props.onPublish}>Publish watch link</button>
        </>
      )}

      <h3>Box score</h3>
      {boxScore.length === 0 ? (
        <p>No events logged yet.</p>
      ) : (
        <table className="boxscore">
          <thead>
            <tr>
              <th>Player</th>
              <th>Points</th>
              <th>Stats</th>
            </tr>
          </thead>
          <tbody>
            {boxScore.map((row) => (
              <tr key={row.name}>
                <td>{row.name}</td>
                <td>{row.points}</td>
                <td>{Object.entries(row.stats).map(([k, v]) => `${k}: ${v}`).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Event timeline</h3>
      <ul className="list">
        {props.events.map((e) => {
          const player = props.players.find((p) => p.id === e.player_id);
          return (
            <li key={e.created_at + e.stat_type + Math.random()}>
              {player ? player.name : 'Opponent'} — {e.stat_type}
              {e.points > 0 ? ` (+${e.points})` : ''} · {new Date(e.created_at).toLocaleTimeString()}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Public watch page — the ONLY thing a /watch/<token> link renders.
 * Standalone: no app nav, no login, no editing, no workspace fetch.
 * Shows only the published game: live score, stream embed, event feed,
 * and per-player scoring stats for this game. Polls the public endpoint
 * every 15s so family sees score updates without reloading. A failed
 * first load means the link is bad, revoked, or unpublished — all three
 * look identical by design, so the message never says which.
 */
function WatchPage({ token }: { token: string }) {
  const [watch, setWatch] = useState<PublicWatch | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let hasLoaded = false;
    async function load() {
      try {
        const w = await api.getPublicWatch(token);
        if (cancelled) return;
        hasLoaded = true;
        setWatch(w);
        setNotFound(false);
      } catch {
        // Poll failures after a successful load leave the last good
        // state in place — only a failed FIRST load shows the message.
        if (!cancelled && !hasLoaded) setNotFound(true);
      }
    }
    load();
    const interval = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [token]);

  if (notFound) {
    return (
      <div className="page">
        <header className="org-header">
          <h1>SimpliGame</h1>
        </header>
        <h2>This game isn&rsquo;t published.</h2>
        <p>
          The link may be mistyped, the game may not be published yet, or the coach may have shared a
          new link. Ask the coach for the current watch link.
        </p>
      </div>
    );
  }

  if (!watch) {
    return (
      <div className="page">
        <p>Loading game…</p>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="org-header">
        <h1>SimpliGame</h1>
        <p className="tagline">Live game</p>
      </header>

      <h2>
        {watch.team_name} vs {watch.opponent || 'TBD'}
      </h2>
      <p className="score">
        {watch.team_name} {watch.our_score} — {watch.opponent_score} {watch.opponent || 'Opponent'}
      </p>
      <p>
        {watch.period_label} · {watch.status === 'live' ? 'Live now' : watch.status === 'final' ? 'Final' : 'Upcoming'}
      </p>

      {watch.youtube_video_id ? (
        <YouTubePlayer videoId={watch.youtube_video_id} isLive={watch.status === 'live'} />
      ) : (
        <p>No stream attached to this game yet.</p>
      )}

      <h3>Box score</h3>
      {watch.boxScore.length === 0 ? (
        <p>No scoring stats yet.</p>
      ) : (
        <table className="boxscore">
          <thead>
            <tr>
              <th>Player</th>
              <th>Points</th>
              <th>Stats</th>
            </tr>
          </thead>
          <tbody>
            {watch.boxScore.map((row) => (
              <tr key={row.name}>
                <td>
                  #{row.jersey_number} {row.name}
                </td>
                <td>{row.points}</td>
                <td>{Object.entries(row.stats).map(([k, v]) => `${k}: ${v}`).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Event feed</h3>
      {watch.events.length === 0 ? (
        <p>No events yet.</p>
      ) : (
        <ul className="list">
          {watch.events.slice(0, 30).map((e, i) => (
            <li key={i}>
              {e.player_name ? `#${e.jersey_number} ${e.player_name}` : 'Opponent'} — {e.stat_type}
              {e.points > 0 ? ` (+${e.points})` : ''} · {new Date(e.created_at).toLocaleTimeString()}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
