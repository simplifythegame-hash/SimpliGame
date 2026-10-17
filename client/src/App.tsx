import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type { AuthUser, Coach, EnrollInfo, FamilyContact, Game, GameAnalysis, Player, PlayerProfile, PlayerProfileStats, PublicProfile, PublicWatch, ReelClip, ReelProject, SheetExport, SmsLogRow, Workspace } from './types';
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

type View = { kind: 'home' } | { kind: 'live'; gameId: string } | { kind: 'detail'; gameId: string } | { kind: 'profile'; playerId: string } | { kind: 'reels' } | { kind: 'reel'; reelId: string } | { kind: 'coaches' };

export default function App() {
  // Public routes render standalone pages INSTEAD of the app shell — no
  // nav, no login, no editing, and no workspace fetch. The pathname
  // never changes during a page load, so these early returns are stable
  // across renders.
  const watchMatch =
    typeof window !== 'undefined' ? window.location.pathname.match(/^\/watch\/([^/]+)$/) : null;
  if (watchMatch) {
    return <WatchPage token={watchMatch[1]} />;
  }
  const profileMatch =
    typeof window !== 'undefined' ? window.location.pathname.match(/^\/profile\/([^/]+)$/) : null;
  if (profileMatch) {
    return <ProfilePage token={profileMatch[1]} />;
  }
  const enrollMatch =
    typeof window !== 'undefined' ? window.location.pathname.match(/^\/enroll\/([^/]+)$/) : null;
  if (enrollMatch) {
    return <EnrollPage token={enrollMatch[1]} />;
  }

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [view, setView] = useState<View>({ kind: 'home' });
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(true);
  // Auth: null = not logged in (login/setup screen). The server enforces
  // everything — the client only renders what the server returns.
  const [me, setMe] = useState<AuthUser | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [authError, setAuthError] = useState('');

  const [teamName, setTeamName] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [playerJersey, setPlayerJersey] = useState('');
  const [playerPosition, setPlayerPosition] = useState('');
  const [opponent, setOpponent] = useState('');
  const [mode, setMode] = useState<'live' | 'film'>('live');
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [editingOrg, setEditingOrg] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [queuedCount, setQueuedCount] = useState(() => api.getQueuedEventCount());
  const [isOffline, setIsOffline] = useState(
    typeof navigator !== 'undefined' ? !navigator.onLine : false,
  );

  useEffect(() => {
    const onQueue = (e: Event) => {
      const count = (e as CustomEvent<{ count: number }>).detail?.count;
      setQueuedCount(typeof count === 'number' ? count : api.getQueuedEventCount());
    };
    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener('simpligame:queue-changed', onQueue);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('simpligame:queue-changed', onQueue);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const ws = await api.getWorkspace();
      setWorkspace(ws);
      setLoading(false);
    } catch (e) {
      // Session expired mid-use → back to the login screen.
      if (e instanceof Error && e.message === 'Please log in.') {
        setMe(null);
        setLoading(false);
        return;
      }
      throw e;
    }
  }, []);

  // Auth bootstrap: check the session first; a logged-in user loads the
  // workspace, everyone else gets the login screen (or the one-time
  // setup form when zero users exist).
  useEffect(() => {
    api
      .getMe()
      .then(async (meResult) => {
        if (meResult.user) {
          setMe(meResult.user);
          await refresh();
        } else {
          const status = await api.getAuthStatus();
          setNeedsSetup(!status.usersExist);
          setLoading(false);
        }
      })
      .catch((e) => {
        setAuthError(e instanceof Error ? e.message : 'Failed to check login');
        setLoading(false);
      });
  }, [refresh]);

  const selectedTeam = workspace?.teams.find((t) => t.id === selectedTeamId);
  const roster = useMemo(
    () => workspace?.players.filter((p) => p.team_id === selectedTeamId) ?? [],
    [workspace, selectedTeamId],
  );
  const currentGame =
    view.kind === 'live' || view.kind === 'detail'
      ? workspace?.games.find((g) => g.id === view.gameId)
      : undefined;

  async function run(action: () => Promise<unknown>) {
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
    setError('');
    try {
      const result = await api.logEvent(currentGame.id, {
        player_id: selectedPlayerId,
        stat_type: stat.label,
        side: 'ours',
        points: stat.points,
        video_seconds: 0,
      });
      // Queued (offline): the event will sync on reconnect — skip the
      // refresh, which would fail offline and surface a confusing error.
      if ((result as { queued?: boolean }).queued) {
        setQueuedCount(api.getQueuedEventCount());
        return;
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
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
  if (authError) return <div className="page"><p className="error">{authError}</p></div>;
  if (!me) {
    const onDone = (user: AuthUser) => {
      setMe(user);
      setLoading(true);
      void refresh();
    };
    return needsSetup ? <SetupScreen onDone={onDone} /> : <LoginScreen onDone={onDone} />;
  }
  if (!workspace) return <div className="page"><p className="error">{error || 'Could not load workspace.'}</p></div>;

  const org = workspace.organization;

  async function handleLogout() {
    try {
      await api.logout();
    } catch {
      // Already logged out server-side — clear local state anyway.
    }
    setMe(null);
    setWorkspace(null);
    setView({ kind: 'home' });
    setSelectedTeamId('');
  }

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
            {me.role === 'owner' && (
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
            )}
          </h1>
        )}
        <p className="tagline">SimpliGame — Simplify the Game</p>
        <p className="sub-hint">
          Signed in as {me.name} ({me.role.replace('_', ' ')}){' '}
          <button type="button" onClick={handleLogout}>
            Logout
          </button>
        </p>
      </header>

      {error && <p className="error">{error}</p>}
      {isOffline && (
        <p className="error">
          You&apos;re offline — new stats are queued and will sync automatically when you&apos;re
          back online.
        </p>
      )}
      {!isOffline && queuedCount > 0 && (
        <p className="mock-note">
          {queuedCount} stat{queuedCount === 1 ? '' : 's'} waiting to sync — they&apos;ll send
          automatically when the connection returns.
        </p>
      )}

      <InstallPrompt />

      <nav className="row">
        <button className={view.kind === 'home' ? 'selected' : ''} onClick={() => setView({ kind: 'home' })}>Teams &amp; Games</button>
        <button
          className={view.kind === 'reels' || view.kind === 'reel' ? 'selected' : ''}
          onClick={() => setView({ kind: 'reels' })}
        >
          Reels
        </button>
        {me.role === 'owner' && (
          <button className={view.kind === 'coaches' ? 'selected' : ''} onClick={() => setView({ kind: 'coaches' })}>
            Coaches
          </button>
        )}
      </nav>

      {view.kind === 'home' && (
        <>
          <section>
            <h2>Teams</h2>
            {me.role === 'owner' && (
              <form onSubmit={handleCreateTeam} className="row">
                <input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="New team name" required />
                <button type="submit">Create team</button>
              </form>
            )}
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
                    #{p.jersey_number} {p.name} — {p.position}{' '}
                    <button onClick={() => setView({ kind: 'profile', playerId: p.id })}>Profile</button>
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
                    {team?.name ?? 'Team'} vs {g.opponent || 'TBD'} — {g.our_score}:{g.opponent_score} ({g.mode} · {g.status})
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
          onSetStatus={async (status) => run(() => api.setGameStatus(currentGame.id, status))}
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
          onAutoReel={async (preset) => {
            const reel = await api.autoReel(currentGame.id, preset);
            setView({ kind: 'reel', reelId: reel.id });
          }}
          onSetStatus={async (status) => run(() => api.setGameStatus(currentGame.id, status))}
          onBack={() => setView({ kind: 'home' })}
          onLive={() => setView({ kind: 'live', gameId: currentGame.id })}
        />
      )}

      {view.kind === 'reels' && (
        <ReelsListScreen
          games={workspace.games}
          teams={workspace.teams}
          onOpen={(reelId) => setView({ kind: 'reel', reelId })}
        />
      )}

      {view.kind === 'reel' && (
        <ReelStudioScreen
          reelId={view.reelId}
          workspace={workspace}
          onBack={() => setView({ kind: 'reels' })}
        />
      )}

      {view.kind === 'profile' && (
        <PlayerProfileScreen
          player={workspace.players.find((p) => p.id === view.playerId)}
          onBack={() => setView({ kind: 'home' })}
        />
      )}

      {view.kind === 'coaches' && me.role === 'owner' && (
        <CoachesScreen teams={workspace.teams} onBack={() => setView({ kind: 'home' })} />
      )}
    </div>
  );
}

/** Login screen: shown when no session exists and users already exist. */
function LoginScreen({ onDone }: { onDone: (user: AuthUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="page">
      <h1>SimpliGame</h1>
      <p className="tagline">Simplify the Game</p>
      <section>
        <h2>Log in</h2>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError('');
            setBusy(true);
            try {
              const user = await api.login(email, password);
              onDone(user);
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Login failed.');
              setBusy(false);
            }
          }}
        >
          <div className="row">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" required autoFocus />
          </div>
          <div className="row">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" required />
          </div>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
        </form>
      </section>
    </div>
  );
}

/** One-time owner setup: shown only when zero users exist. Creates the
 *  owner account and logs in immediately. After the first user exists
 *  the server refuses this endpoint. */
function SetupScreen({ onDone }: { onDone: (user: AuthUser) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="page">
      <h1>SimpliGame</h1>
      <p className="tagline">Simplify the Game</p>
      <section>
        <h2>Set up the owner account</h2>
        <p className="sub-hint">
          This is a one-time setup. Create the owner login for your organization — choose a
          password of at least 8 characters.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError('');
            setBusy(true);
            try {
              const user = await api.setup(name, email, password);
              onDone(user);
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Setup failed.');
              setBusy(false);
            }
          }}
        >
          <div className="row">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" required maxLength={100} autoFocus />
          </div>
          <div className="row">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" required />
          </div>
          <div className="row">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (8+ characters)" required />
          </div>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create owner account'}</button>
        </form>
      </section>
    </div>
  );
}

/** Owner-only coach management: add coaches with a role + team
 *  assignments, change a coach's role/teams, remove a coach. */
function CoachesScreen({ teams, onBack }: { teams: { id: string; name: string }[]; onBack: () => void }) {
  const [coaches, setCoaches] = useState<Coach[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('assistant');
  const [newTeamIds, setNewTeamIds] = useState<string[]>([]);
  const [editState, setEditState] = useState<Record<string, { role: string; teamIds: string[] }>>({});

  const load = useCallback(async () => {
    try {
      setCoaches(await api.listCoaches());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load coaches');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleTeam(list: string[], teamId: string) {
    return list.includes(teamId) ? list.filter((t) => t !== teamId) : [...list, teamId];
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api.createCoach({ name, email, password, role, teamIds: newTeamIds });
      setName('');
      setEmail('');
      setPassword('');
      setNewTeamIds([]);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add coach');
    }
  }

  async function handleSave(coach: Coach) {
    setError('');
    const edit = editState[coach.id];
    if (!edit) return;
    try {
      await api.updateCoach(coach.id, { role: edit.role, teamIds: edit.teamIds });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save coach');
    }
  }

  async function handleRemove(coach: Coach) {
    if (!window.confirm(`Remove ${coach.name} (${coach.email})? They will no longer be able to log in.`)) return;
    setError('');
    try {
      await api.deleteCoach(coach.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove coach');
    }
  }

  function startEdit(coach: Coach) {
    setEditState((prev) => ({ ...prev, [coach.id]: { role: coach.role, teamIds: [...coach.teamIds] } }));
  }

  if (loading) return <p>Loading coaches…</p>;
  return (
    <section>
      <h2>Coaches</h2>
      <button type="button" onClick={onBack}>Back</button>
      {error && <p className="error">{error}</p>}
      <h3>Add a coach</h3>
      <p className="sub-hint">A coach sees only the teams you check. The owner sees everything.</p>
      <form onSubmit={handleAdd}>
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" required maxLength={100} />
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" required />
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (8+ characters)" required />
        </div>
        <div className="row">
          <label className="field-label">
            Role
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="head_coach">Head coach</option>
              <option value="assistant">Assistant</option>
              <option value="stat_crew">Stat crew</option>
            </select>
          </label>
        </div>
        <div className="row">
          {teams.map((t) => (
            <label key={t.id} className="field-label">
              <input
                type="checkbox"
                checked={newTeamIds.includes(t.id)}
                onChange={() => setNewTeamIds((prev) => toggleTeam(prev, t.id))}
              />
              {t.name}
            </label>
          ))}
        </div>
        <button type="submit">Add coach</button>
      </form>
      <ul className="list">
        {coaches.map((c) => {
          const edit = editState[c.id];
          const teamNames = teams.filter((t) => c.teamIds.includes(t.id)).map((t) => t.name);
          return (
            <li key={c.id}>
              <strong>{c.name}</strong> — {c.email} — {c.role.replace('_', ' ')}
              {c.role === 'owner' ? (
                <span> (owner — sees all teams)</span>
              ) : (
                <>
                  <span> — Teams: {teamNames.length > 0 ? teamNames.join(', ') : 'none'}</span>{' '}
                  {edit ? (
                    <>
                      <div className="row">
                        <select value={edit.role} onChange={(e) => setEditState((prev) => ({ ...prev, [c.id]: { ...edit, role: e.target.value } }))}>
                          <option value="head_coach">Head coach</option>
                          <option value="assistant">Assistant</option>
                          <option value="stat_crew">Stat crew</option>
                        </select>
                      </div>
                      <div className="row">
                        {teams.map((t) => (
                          <label key={t.id} className="field-label">
                            <input
                              type="checkbox"
                              checked={edit.teamIds.includes(t.id)}
                              onChange={() =>
                                setEditState((prev) => ({
                                  ...prev,
                                  [c.id]: { ...edit, teamIds: toggleTeam(edit.teamIds, t.id) },
                                }))
                              }
                            />
                            {t.name}
                          </label>
                        ))}
                      </div>
                      <button type="button" onClick={() => void handleSave(c)}>Save</button>{' '}
                      <button type="button" onClick={() => setEditState((prev) => {
                        const next = { ...prev };
                        delete next[c.id];
                        return next;
                      })}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" onClick={() => startEdit(c)}>Edit</button>{' '}
                      <button type="button" onClick={() => void handleRemove(c)}>Remove</button>
                    </>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Install prompt: uses the beforeinstallprompt event when the browser
 * offers it (Chrome/Edge/Android). iOS Safari never fires that event, so
 * iPhones get the manual Share → Add to Home Screen instructions instead.
 * Hidden once the app runs installed (standalone display mode) or after
 * the coach dismisses it. The service worker registration lives in
 * main.tsx (production only); this component is only the UI.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as { standalone?: boolean }).standalone === true;
    setIsStandalone(standalone);
    const onBefore = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setIsStandalone(true);
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', onBefore);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBefore);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (isStandalone || dismissed) return null;

  if (deferred) {
    return (
      <div className="row">
        <button
          onClick={async () => {
            await deferred.prompt();
            setDeferred(null);
          }}
        >
          Install app
        </button>
        <button type="button" onClick={() => setDismissed(true)}>
          Not now
        </button>
        <small>Install SimpliGame on your home screen for fast, app-like access.</small>
      </div>
    );
  }

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIOS) {
    return (
      <p>
        <small>
          On iPhone: tap Share (the box with an arrow) → Add to Home Screen to install
          SimpliGame.
        </small>
      </p>
    );
  }

  return null;
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
  onSetStatus: (status: 'live' | 'final') => Promise<void>;
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
      <p>
        Status: <strong>{props.game.status}</strong>
      </p>
      <div className="row">
        {props.game.status === 'draft' && (
          <button onClick={() => props.onSetStatus('live')}>Go Live</button>
        )}
        {props.game.status === 'live' && (
          <button onClick={() => props.onSetStatus('final')}>End Game</button>
        )}
        {props.game.status === 'final' && <span>Final — this game is closed.</span>}
      </div>
      {props.game.status === 'draft' && !props.game.published && (
        <p>
          <small>Publish first to text families the watch link when you go live.</small>
        </p>
      )}
      {props.game.status === 'draft' && props.game.published && (
        <p>
          <small>Families get the watch link by text the moment you go live.</small>
        </p>
      )}

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
  events: { player_id: string | null; stat_type: string; points: number; side: string; created_at: string; video_seconds: number }[];
  youtubeUrl: string;
  onYoutubeUrlChange: (v: string) => void;
  onSaveYouTube: () => void;
  onPublish: () => void;
  onUnpublish: () => void;
  onRevoke: () => void;
  onAutoReel: (preset: 'hype' | 'clean' | 'simple') => Promise<void>;
  onSetStatus: (status: 'live' | 'final') => Promise<void>;
  onBack: () => void;
  onLive: () => void;
}) {
  // Box score: per-player counts by stat type, plus points.
  const [copied, setCopied] = useState(false);
  const [autoPreset, setAutoPreset] = useState<'hype' | 'clean' | 'simple'>('hype');
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoError, setAutoError] = useState('');
  // Family texts: delivery log is best-effort — a failed fetch leaves the
  // section empty rather than breaking the whole detail screen.
  const [smsLog, setSmsLog] = useState<SmsLogRow[]>([]);
  const [smsBusy, setSmsBusy] = useState(false);
  const [smsResult, setSmsResult] = useState('');
  const [smsError, setSmsError] = useState('');
  // Google Sheets export: past exports list is best-effort, same as SMS.
  const [sheetExports, setSheetExports] = useState<SheetExport[]>([]);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetResult, setSheetResult] = useState('');
  const [sheetError, setSheetError] = useState('');
  // Post-game analysis: overview is computed server-side from the
  // game's real data; review state is best-effort, same as SMS/Sheets.
  const [analysis, setAnalysis] = useState<GameAnalysis | null>(null);
  const [analysisError, setAnalysisError] = useState('');
  const [analysisBusyKey, setAnalysisBusyKey] = useState<string | null>(null);
  const [analysisInputs, setAnalysisInputs] = useState<Record<string, { correction: string; note: string }>>({});

  async function loadAnalysis() {
    try {
      setAnalysis(await api.getAnalysis(props.game.id));
    } catch (e) {
      setAnalysisError(e instanceof Error ? e.message : 'Analysis failed to load');
    }
  }

  async function loadSmsLog() {
    try {
      setSmsLog(await api.getSmsLog(props.game.id));
    } catch {
      // Best-effort: the log stays as-is on failure.
    }
  }

  async function loadSheetExports() {
    try {
      setSheetExports(await api.getSheetExports(props.game.id));
    } catch {
      // Best-effort: the list stays as-is on failure.
    }
  }

  useEffect(() => {
    void loadSmsLog();
    void loadSheetExports();
    void loadAnalysis();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.game.id]);
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

  // CSV export: a real CSV built client-side from the same game data,
  // so export always works — with or without Google configured.
  // Columns mirror the Google Sheets tabs (Box Score, Timeline).
  function csvEscape(value: string | number): string {
    const s = String(value);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function downloadCsv() {
    const statTypes = [...new Set(props.events.map((e) => e.stat_type))].sort();
    const lines: string[] = [];
    lines.push('Box Score');
    lines.push(['Player', 'Jersey', 'Points', ...statTypes].map(csvEscape).join(','));
    for (const row of boxScore) {
      const player = props.players.find((p) => p.name === row.name);
      lines.push(
        [row.name, player?.jersey_number ?? '', row.points, ...statTypes.map((t) => row.stats[t] ?? 0)]
          .map(csvEscape)
          .join(','),
      );
    }
    lines.push('');
    lines.push('Timeline');
    lines.push(['Time', 'Player', 'Stat', 'Side', 'Points', 'Video'].map(csvEscape).join(','));
    for (const e of props.events) {
      const player = props.players.find((p) => p.id === e.player_id);
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
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `simpligame-${props.game.opponent || 'game'}-${props.game.id.slice(0, 8)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <section>
      <button onClick={props.onBack}>← All games</button>{' '}
      <button onClick={props.onLive}>Live screen</button>
      <h2>
        Game detail — vs {props.game.opponent || 'TBD'} · Final {props.game.our_score}:{props.game.opponent_score}
      </h2>
      <p>
        Status: <strong>{props.game.status}</strong>
      </p>
      <div className="row">
        {props.game.status === 'draft' && (
          <button onClick={() => props.onSetStatus('live')}>Go Live</button>
        )}
        {props.game.status === 'live' && (
          <button onClick={() => props.onSetStatus('final')}>End Game</button>
        )}
        {props.game.status === 'final' && <span>Final — this game is closed.</span>}
      </div>
      {props.game.status === 'draft' && !props.game.published && (
        <p>
          <small>Publish first to text families the watch link when you go live.</small>
        </p>
      )}
      {props.game.status === 'draft' && props.game.published && (
        <p>
          <small>Families get the watch link by text the moment you go live.</small>
        </p>
      )}

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

      <h3>Family texts</h3>
      {!props.game.published ? (
        <p>Publish this game first — texts need a watch link to send.</p>
      ) : (
        <p>
          Families get the watch link by text the moment you tap Go Live. Highlights alerts go
          out with the button below.
        </p>
      )}
      <div className="row">
        <button
          disabled={!props.game.published || smsBusy}
          onClick={async () => {
            setSmsBusy(true);
            setSmsResult('');
            setSmsError('');
            try {
              const summary = await api.notifyHighlights(props.game.id);
              setSmsResult(
                `Highlights alerts: ${summary.attempted} attempted — ${summary.sent} sent, ${summary.logged} recorded (Twilio not configured), ${summary.failed} failed.`,
              );
              await loadSmsLog();
            } catch (e) {
              setSmsError(e instanceof Error ? e.message : 'Highlights alerts failed');
            } finally {
              setSmsBusy(false);
            }
          }}
        >
          {smsBusy ? 'Sending…' : 'Notify families (highlights ready)'}
        </button>
      </div>
      {smsResult && <p>{smsResult}</p>}
      {smsError && <p className="error">{smsError}</p>}
      {smsLog.length === 0 ? (
        <p>No texts recorded yet.</p>
      ) : (
        <ul className="list">
          {smsLog.map((row) => (
            <li key={row.id}>
              {row.message_type === 'go_live' ? 'Go Live' : 'Highlights'} →{' '}
              {row.masked_phone ?? 'Removed contact'} — {row.status}
              {row.status === 'logged' ? ' (Twilio not configured — recorded, not sent)' : ''}
              {row.error ? ` — ${row.error}` : ''} · {new Date(row.created_at).toLocaleTimeString()}
            </li>
          ))}
        </ul>
      )}

      <h3>Auto Reel</h3>
      <p>
        One tap builds a draft reel from this game&apos;s highlights (best plays first) and opens it
        in Reel Studio for tweaking.
      </p>
      <div className="row">
        <select value={autoPreset} onChange={(e) => setAutoPreset(e.target.value as 'hype' | 'clean' | 'simple')}>
          <option value="hype">Hype — fades + overlays</option>
          <option value="clean">Clean — cuts + overlays</option>
          <option value="simple">Simple — cuts, no overlays</option>
        </select>
        <button
          disabled={autoBusy}
          onClick={async () => {
            setAutoBusy(true);
            setAutoError('');
            try {
              await props.onAutoReel(autoPreset);
            } catch (e) {
              setAutoError(e instanceof Error ? e.message : 'Auto Reel failed');
            } finally {
              setAutoBusy(false);
            }
          }}
        >
          {autoBusy ? 'Building…' : 'Auto Reel'}
        </button>
      </div>
      {autoError && <p className="error">{autoError}</p>}

      <h3>Export</h3>
      <p>
        Export this game&apos;s box score + timeline to a Google Sheet, or download the same data
        as a CSV — the CSV always works, with or without Google configured.
      </p>
      <div className="row">
        <button
          disabled={sheetBusy}
          onClick={async () => {
            setSheetBusy(true);
            setSheetResult('');
            setSheetError('');
            try {
              const result = await api.exportToSheets(props.game.id);
              if (result.notConfigured) {
                setSheetResult(
                  'Google Sheets is not configured yet — set the Google service-account env vars on the server, then try again. (The CSV download below works right now.)',
                );
              } else {
                setSheetResult(`Exported to Google Sheets.`);
                setSheetExports((prev) => [
                  {
                    id: `new-${Date.now()}`,
                    game_id: props.game.id,
                    sheet_id: result.sheetId ?? '',
                    sheet_url: result.sheetUrl ?? '',
                    created_at: new Date().toISOString(),
                  },
                  ...prev,
                ]);
              }
            } catch (e) {
              setSheetError(e instanceof Error ? e.message : 'Google Sheets export failed');
            } finally {
              setSheetBusy(false);
            }
          }}
        >
          {sheetBusy ? 'Exporting…' : 'Export to Google Sheets'}
        </button>
        <button type="button" onClick={downloadCsv}>
          Download CSV
        </button>
      </div>
      {sheetResult && <p>{sheetResult}</p>}
      {sheetError && <p className="error">{sheetError}</p>}
      {sheetExports.length > 0 && (
        <ul className="list">
          {sheetExports.map((x) => (
            <li key={x.id}>
              <a href={x.sheet_url} target="_blank" rel="noreferrer">
                Open Sheet
              </a>{' '}
              · {new Date(x.created_at).toLocaleString()}
            </li>
          ))}
        </ul>
      )}

      <h3>Post-Game Analysis</h3>
      <p>
        <small>
          Overview computed from this game&apos;s recorded data — not AI. Check each section and
          verify it; only verified sections count as official.
        </small>
      </p>
      {analysisError && <p className="error">{analysisError}</p>}
      {analysis && (
        <>
          <p>
            Overall: <strong>{analysis.overall_status}</strong> ·{' '}
            {analysis.sections.filter((s) => s.verified).length} of {analysis.sections.length} sections verified
          </p>
          <ul className="list">
            {analysis.sections.map((section) => {
              const inputs = analysisInputs[section.key] ?? { correction: '', note: '' };
              const badge = section.verified
                ? '✓ Verified'
                : section.confidence === 'missing'
                  ? 'Missing'
                  : section.confidence === 'high'
                    ? 'High confidence'
                    : 'Estimated';
              return (
                <li key={section.key}>
                  <strong>{section.title}</strong> — {badge}
                  <br />
                  {section.summary}
                  {section.detail.length > 0 && (
                    <ul>
                      {section.detail.map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                  )}
                  {section.verified ? (
                    <>
                      {section.correction && (
                        <p>
                          <small>Correction: {section.correction}</small>
                        </p>
                      )}
                      {section.note && (
                        <p>
                          <small>Note: {section.note}</small>
                        </p>
                      )}
                      <button
                        type="button"
                        disabled={analysisBusyKey === section.key}
                        onClick={async () => {
                          setAnalysisBusyKey(section.key);
                          setAnalysisError('');
                          try {
                            setAnalysis(await api.unverifyAnalysisSection(props.game.id, section.key));
                          } catch (e) {
                            setAnalysisError(e instanceof Error ? e.message : 'Unverify failed');
                          } finally {
                            setAnalysisBusyKey(null);
                          }
                        }}
                      >
                        {analysisBusyKey === section.key ? 'Working…' : 'Unverify'}
                      </button>
                    </>
                  ) : (
                    <div className="row">
                      <input
                        placeholder="Correction (optional)"
                        value={inputs.correction}
                        onChange={(e) =>
                          setAnalysisInputs((prev) => ({
                            ...prev,
                            [section.key]: { ...inputs, correction: e.target.value },
                          }))
                        }
                      />
                      <input
                        placeholder="Note (optional)"
                        value={inputs.note}
                        onChange={(e) =>
                          setAnalysisInputs((prev) => ({
                            ...prev,
                            [section.key]: { ...inputs, note: e.target.value },
                          }))
                        }
                      />
                      <button
                        type="button"
                        disabled={analysisBusyKey === section.key}
                        onClick={async () => {
                          setAnalysisBusyKey(section.key);
                          setAnalysisError('');
                          try {
                            setAnalysis(
                              await api.verifyAnalysisSection(
                                props.game.id,
                                section.key,
                                inputs.correction,
                                inputs.note,
                              ),
                            );
                          } catch (e) {
                            setAnalysisError(e instanceof Error ? e.message : 'Verify failed');
                          } finally {
                            setAnalysisBusyKey(null);
                          }
                        }}
                      >
                        {analysisBusyKey === section.key ? 'Working…' : 'Verify'}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
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

/** Format a video timestamp (seconds) as m:ss for highlight links. */
function formatTimestamp(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function videoLink(videoId: string | null, seconds: number) {
  if (!videoId) return null;
  return `https://www.youtube.com/watch?v=${videoId}&t=${seconds}s`;
}

/** Shared stats display: career totals + per-game breakdown. Read-only —
 *  stats are always computed from the player's game events. */
function ProfileStats({ stats }: { stats: PlayerProfileStats }) {
  const totalEntries = Object.entries(stats.totals);
  return (
    <>
      <h3>Career stats</h3>
      {totalEntries.length === 0 ? (
        <p>No stats logged yet — stats appear automatically as events are tagged in games.</p>
      ) : (
        <>
          <p>
            {stats.gamesPlayed} game{stats.gamesPlayed === 1 ? '' : 's'} · {stats.totalPoints} points
          </p>
          <table className="boxscore">
            <thead>
              <tr>
                <th>Stat</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {totalEntries.map(([stat, count]) => (
                <tr key={stat}>
                  <td>{stat}</td>
                  <td>{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {stats.byGame.length > 0 && (
        <>
          <h4>By game</h4>
          <ul className="list">
            {stats.byGame.map((g, i) => (
              <li key={i}>
                vs {g.opponent || 'TBD'} · {g.date} —{' '}
                {Object.entries(g.stats).map(([k, v]) => `${k}: ${v}`).join(' · ')} ({g.points} pts)
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function ProfileHighlights({ stats }: { stats: PlayerProfileStats }) {
  if (stats.highlights.length === 0) return null;
  return (
    <>
      <h3>Highlights</h3>
      <ul className="list">
        {stats.highlights.map((h, i) => {
          const link = videoLink(h.youtube_video_id, h.video_seconds);
          return (
            <li key={i}>
              {h.stat_type}
              {h.points > 0 ? ` (+${h.points})` : ''} — vs {h.opponent || 'TBD'} ·{' '}
              {link ? (
                <a href={link} target="_blank" rel="noreferrer">
                  Watch at {formatTimestamp(h.video_seconds)}
                </a>
              ) : (
                `at ${formatTimestamp(h.video_seconds)} (no video attached)`
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * Coach-side player profile: editable bio + measurables, auto-aggregated
 * stats (read-only), highlight events with video-timestamp links, and
 * publish controls using the same token model as game watch links.
 */
function PlayerProfileScreen(props: { player: Player | undefined; onBack: () => void }) {
  const [data, setData] = useState<{
    player: Player;
    profile: PlayerProfile | null;
    stats: PlayerProfileStats;
  } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [bio, setBio] = useState('');
  const [height, setHeight] = useState('');
  const [graduationYear, setGraduationYear] = useState('');
  const [positionsText, setPositionsText] = useState('');
  const [school, setSchool] = useState('');
  const [clubTeam, setClubTeam] = useState('');
  // Family enrollment: masked contacts only — full numbers never reach
  // this screen.
  const [family, setFamily] = useState<FamilyContact[]>([]);
  const [enrollCopied, setEnrollCopied] = useState(false);

  const playerId = props.player?.id;

  const load = useCallback(async () => {
    if (!playerId) return;
    const result = await api.getPlayerProfile(playerId);
    setData(result);
    setFamily(await api.getFamily(playerId));
    setBio(result.profile?.bio ?? '');
    setHeight(result.profile?.height ?? '');
    setGraduationYear(result.profile?.graduation_year ?? '');
    setPositionsText(result.profile?.positions_text ?? '');
    setSchool(result.profile?.school ?? '');
    setClubTeam(result.profile?.club_team ?? '');
  }, [playerId]);

  useEffect(() => {
    if (!playerId) {
      setLoading(false);
      return;
    }
    load()
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load profile'))
      .finally(() => setLoading(false));
  }, [playerId, load]);

  if (!props.player) {
    return (
      <section>
        <button onClick={props.onBack}>← Back</button>
        <p>Player not found.</p>
      </section>
    );
  }

  if (loading) return <section><p>Loading profile…</p></section>;

  const player = props.player;
  const profile = data?.profile ?? null;

  async function run(action: () => Promise<unknown>) {
    setError('');
    setSaved(false);
    try {
      await action();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  }

  return (
    <section>
      <button onClick={props.onBack}>← Back</button>
      <h2>
        Profile — #{player.jersey_number} {player.name} · {player.position}
      </h2>

      {error && <p className="error">{error}</p>}
      {saved && <p>Profile saved.</p>}

      <h3>Bio & measurables</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await api.updatePlayerProfile(player.id, {
              bio,
              height,
              graduation_year: graduationYear,
              positions_text: positionsText,
              school,
              club_team: clubTeam,
            });
            setSaved(true);
          });
        }}
      >
        <div className="row">
          <label className="field-label">
            Bio
            <textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={2000} rows={4} className="wide" />
          </label>
        </div>
        <div className="row">
          <label className="field-label">
            Height
            <input value={height} onChange={(e) => setHeight(e.target.value)} maxLength={100} placeholder="e.g. 5'10&quot;" />
          </label>
          <label className="field-label">
            Graduation year
            <input value={graduationYear} onChange={(e) => setGraduationYear(e.target.value)} maxLength={100} placeholder="e.g. 2027" />
          </label>
          <label className="field-label">
            Positions
            <input value={positionsText} onChange={(e) => setPositionsText(e.target.value)} maxLength={100} placeholder="e.g. Outside Hitter / DS" />
          </label>
        </div>
        <div className="row">
          <label className="field-label">
            School
            <input value={school} onChange={(e) => setSchool(e.target.value)} maxLength={100} />
          </label>
          <label className="field-label">
            Club team
            <input value={clubTeam} onChange={(e) => setClubTeam(e.target.value)} maxLength={100} />
          </label>
        </div>
        <button type="submit">Save profile</button>
      </form>

      {data && (
        <>
          <ProfileStats stats={data.stats} />
          <ProfileHighlights stats={data.stats} />
        </>
      )}

      <h3>Family text alerts</h3>
      <p>
        Families sign themselves up with their own number — the coach never enters phone
        numbers. Numbers stay masked here.
      </p>
      {data?.player.enroll_token ? (
        <>
          <p>Share this link with the player&apos;s family:</p>
          <div className="row">
            <input
              readOnly
              value={`${window.location.origin}/enroll/${data.player.enroll_token}`}
              className="wide"
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    `${window.location.origin}/enroll/${data.player.enroll_token}`,
                  );
                  setEnrollCopied(true);
                  setTimeout(() => setEnrollCopied(false), 2000);
                } catch {
                  // Clipboard unavailable — the input above is selected on
                  // focus, so the coach can copy it manually.
                }
              }}
            >
              {enrollCopied ? 'Copied!' : 'Copy link'}
            </button>
          </div>
          <div className="row">
            <button
              onClick={() => run(async () => {
                await api.generateEnrollToken(player.id);
              })}
            >
              Regenerate link
            </button>
          </div>
          <p>
            <small>Regenerating the link kills the old one.</small>
          </p>
        </>
      ) : (
        <>
          <p>No enrollment link yet.</p>
          <button
            onClick={() => run(async () => {
              await api.generateEnrollToken(player.id);
            })}
          >
            Create enrollment link
          </button>
        </>
      )}
      <h4>Enrolled contacts</h4>
      {family.length === 0 ? (
        <p>No family contacts yet.</p>
      ) : (
        <ul className="list">
          {family.map((c) => (
            <li key={c.id}>
              {c.display_name ? `${c.display_name} — ` : ''}
              {c.masked_phone} {c.opted_in ? '(opted in)' : '(opted out)'}{' '}
              <button
                onClick={() => run(async () => {
                  await api.removeFamily(c.id);
                })}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3>Public profile link</h3>
      {profile?.profile_published && profile.profile_token ? (
        <>
          <p>Published — anyone with the link can view this profile. No login needed.</p>
          <div className="row">
            <input
              readOnly
              value={`${window.location.origin}/profile/${profile.profile_token}`}
              className="wide"
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    `${window.location.origin}/profile/${profile.profile_token}`,
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
            <button onClick={() => run(() => api.unpublishProfile(player.id))}>Unpublish</button>
            <button onClick={() => run(() => api.revokeProfileLink(player.id))}>Regenerate link</button>
          </div>
          <p>
            <small>Regenerating the link kills the old one — anyone with the old link can no longer view the profile.</small>
          </p>
        </>
      ) : (
        <>
          <p>Not published — the profile link only works after you publish it.</p>
          <button onClick={() => run(() => api.publishProfile(player.id))}>Publish profile link</button>
        </>
      )}
    </section>
  );
}

/**
 * Public profile page — the ONLY thing a /profile/<token> link renders.
 * Standalone: no app nav, no login, no editing, no workspace fetch.
 * Shows only the published player: header, bio, measurables, stats,
 * highlights with video links. Print/PDF via the browser's print dialog.
 * A failed load means the link is bad, revoked, or unpublished — all
 * three look identical by design, so the message never says which.
 */
function ProfilePage({ token }: { token: string }) {
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getPublicProfile(token)
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (notFound) {
    return (
      <div className="page">
        <header className="org-header">
          <h1>SimpliGame</h1>
        </header>
        <h2>This profile isn&rsquo;t published.</h2>
        <p>
          The link may be mistyped, the profile may not be published yet, or the coach may have
          shared a new link. Ask the coach for the current profile link.
        </p>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="page">
        <p>Loading profile…</p>
      </div>
    );
  }

  const measurables: [string, string][] = [
    ['Height', profile.height],
    ['Graduation year', profile.graduation_year],
    ['Positions', profile.positions_text],
    ['School', profile.school],
    ['Club team', profile.club_team],
  ].filter(([, v]) => v !== '') as [string, string][];

  return (
    <div className="page">
      <header className="org-header">
        <h1>SimpliGame</h1>
        <p className="tagline">Recruiting profile</p>
      </header>

      <h2>
        #{profile.jersey_number} {profile.name}
      </h2>
      <p>
        {profile.position} · {profile.team_name}
      </p>

      {profile.bio && (
        <>
          <h3>About</h3>
          <p>{profile.bio}</p>
        </>
      )}

      {measurables.length > 0 && (
        <>
          <h3>Measurables</h3>
          <table className="boxscore">
            <tbody>
              {measurables.map(([label, value]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <ProfileStats stats={profile.stats} />
      <ProfileHighlights stats={profile.stats} />

      <div className="row no-print">
        <button onClick={() => window.print()}>Print / Save as PDF</button>
      </div>
    </div>
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

/**
 * Reels section: list of saved reel projects + create. Auto Reel lives
 * on Game Detail (it needs a game); this screen is the library.
 */
function ReelsListScreen(props: {
  games: Game[];
  teams: import('./types').Team[];
  onOpen: (reelId: string) => void;
}) {
  const [reels, setReels] = useState<ReelProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [newGameId, setNewGameId] = useState('');

  const load = useCallback(async () => {
    const list = await api.listReels();
    setReels(list);
  }, []);

  useEffect(() => {
    load()
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load reels'))
      .finally(() => setLoading(false));
  }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const reel = await api.createReel({
        name: newName.trim() || undefined,
        game_id: newGameId || null,
      });
      props.onOpen(reel.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create reel');
    }
  }

  async function handleDelete(reelId: string) {
    setError('');
    try {
      await api.deleteReel(reelId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete reel');
    }
  }

  if (loading) return <section><p>Loading reels…</p></section>;

  return (
    <section>
      <h2>Reels</h2>
      {error && <p className="error">{error}</p>}
      <form onSubmit={handleCreate} className="row">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New reel name (optional)" />
        <select value={newGameId} onChange={(e) => setNewGameId(e.target.value)}>
          <option value="">No source game</option>
          {props.games.map((g) => {
            const team = props.teams.find((t) => t.id === g.team_id);
            return (
              <option key={g.id} value={g.id}>
                {team?.name ?? 'Team'} vs {g.opponent || 'TBD'}
              </option>
            );
          })}
        </select>
        <button type="submit">Create reel</button>
      </form>
      {reels.length === 0 ? (
        <p>
          No reels yet. Create one here, or use <strong>Auto Reel</strong> on a game&apos;s detail
          page to build a draft from its highlights.
        </p>
      ) : (
        <ul className="list">
          {reels.map((r) => {
            const game = props.games.find((g) => g.id === r.game_id);
            const team = props.teams.find((t) => t.id === game?.team_id);
            return (
              <li key={r.id}>
                <strong>{r.name}</strong> · {r.clips.length} clip{r.clips.length === 1 ? '' : 's'} ·{' '}
                {r.music_track || 'No music'} · {r.status}
                {game ? ` · ${team?.name ?? 'Team'} vs ${game.opponent || 'TBD'}` : ''}
                {' '}
                <button onClick={() => props.onOpen(r.id)}>Open in Studio</button>{' '}
                <button onClick={() => handleDelete(r.id)}>Delete</button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Built-in placeholder music tracks (names only — no real audio files,
 *  no audio playback in this round). Ids match the server's list. */
const MUSIC_TRACK_OPTIONS = [
  { id: 'none', name: 'No music' },
  { id: 'hype-energy', name: 'Hype Energy (placeholder)' },
  { id: 'pump-up', name: 'Pump Up (placeholder)' },
  { id: 'chill-warmup', name: 'Chill Warm-Up (placeholder)' },
  { id: 'cinematic', name: 'Cinematic (placeholder)' },
];

/**
 * Reel Studio: reorder clips, trim (start/end), per-clip transition,
 * text overlays, slow-motion toggle, music selection, preview (clips
 * in sequence via YouTube embeds jumping to each clip's timestamp),
 * and mock export. Projects persist server-side.
 *
 * Honest limits (same as the prototype): preview plays each clip's
 * source video at its timestamp — it does not render a combined file.
 * Export is a placeholder: no real MP4 is produced in this build.
 */
function ReelStudioScreen(props: { reelId: string; workspace: Workspace; onBack: () => void }) {
  const [reel, setReel] = useState<ReelProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [name, setName] = useState('');
  const [clips, setClips] = useState<ReelClip[]>([]);
  const [musicTrack, setMusicTrack] = useState('');
  const [exportMessage, setExportMessage] = useState('');
  const [addGameId, setAddGameId] = useState('');

  // Preview: which clip is playing, and whether auto-advance is on.
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewPlaying, setPreviewPlaying] = useState(false);

  const load = useCallback(async () => {
    const r = await api.getReel(props.reelId);
    setReel(r);
    setName(r.name);
    setClips(r.clips);
    setMusicTrack(r.music_track);
  }, [props.reelId]);

  useEffect(() => {
    load()
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load reel'))
      .finally(() => setLoading(false));
  }, [load]);

  // Preview auto-advance: after the current clip's trimmed length
  // (doubled in slow motion), step to the next clip; stop at the end.
  useEffect(() => {
    if (!previewPlaying || clips.length === 0) return;
    const clip = clips[previewIndex];
    if (!clip) {
      setPreviewPlaying(false);
      return;
    }
    const duration = Math.max(1, clip.endSeconds - clip.startSeconds) * (clip.slowMo ? 2 : 1) * 1000;
    const t = setTimeout(() => {
      if (previewIndex + 1 < clips.length) {
        setPreviewIndex(previewIndex + 1);
      } else {
        setPreviewPlaying(false);
      }
    }, duration);
    return () => clearTimeout(t);
  }, [previewPlaying, previewIndex, clips]);

  if (loading) return <section><p>Loading reel…</p></section>;
  if (!reel) return <section><button onClick={props.onBack}>← Reels</button><p className="error">{error || 'Reel not found.'}</p></section>;

  // Non-null alias: TS narrowing from the guard above does not carry
  // into the async handler closures below, so bind it explicitly.
  const activeReel: ReelProject = reel;

  function updateClip(index: number, patch: Partial<ReelClip>) {
    setClips((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  function moveClip(index: number, direction: -1 | 1) {
    setClips((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function handleSave() {
    setError('');
    setSaved(false);
    try {
      const updated = await api.updateReel(activeReel.id, { name: name.trim() || activeReel.name, clips, music_track: musicTrack });
      setReel(updated);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save reel');
    }
  }

  async function handleExport() {
    setError('');
    setExportMessage('');
    try {
      const result = await api.exportReel(activeReel.id);
      setExportMessage(result.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    }
  }

  async function handleDelete() {
    setError('');
    try {
      await api.deleteReel(activeReel.id);
      props.onBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete reel');
    }
  }

  // Highlights available to add: this workspace's scoring events for the
  // chosen game (Substitution and opponent points are not highlights).
  const addGame = props.workspace.games.find((g) => g.id === addGameId);
  const addableEvents = addGame
    ? props.workspace.events.filter(
        (e) =>
          e.game_id === addGame.id &&
          e.player_id &&
          ['Kill', 'Ace', 'Block', 'Assist', 'Dig'].includes(e.stat_type),
      )
    : [];

  const previewClip = clips[previewIndex];

  return (
    <section>
      <button onClick={props.onBack}>← Reels</button>
      <h2>Reel Studio — {reel.name}</h2>
      <p>
        <small>
          {clips.length} clip{clips.length === 1 ? '' : 's'} · {reel.status} · Export is a placeholder
          in this build — no real MP4 is produced yet.
        </small>
      </p>
      {error && <p className="error">{error}</p>}
      {saved && <p>Reel saved.</p>}

      <div className="row">
        <label className="field-label">
          Reel name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} className="wide" />
        </label>
        <label className="field-label">
          Music (placeholder — no real audio)
          <select value={musicTrack} onChange={(e) => setMusicTrack(e.target.value)}>
            {MUSIC_TRACK_OPTIONS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <button onClick={handleSave}>Save reel</button>
        <button
          onClick={async () => {
            setError('');
            try {
              const updated = await api.updateReel(reel.id, { status: 'ready' });
              setReel(updated);
              setSaved(true);
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Failed to mark ready');
            }
          }}
        >
          Mark ready
        </button>
        <button onClick={handleExport}>Export (mock)</button>
        <button onClick={handleDelete}>Delete reel</button>
      </div>
      {exportMessage && <p className="mock-note">{exportMessage}</p>}

      <h3>Preview</h3>
      {clips.length === 0 ? (
        <p>No clips yet — add highlights below, or use Auto Reel on a game to build a draft.</p>
      ) : (
        <>
          <p>
            Clip {previewIndex + 1} of {clips.length}
            {previewClip?.overlay ? ` — “${previewClip.overlay}”` : ''}
            {previewClip?.slowMo ? ' · slow motion' : ''} · transition:{' '}
            {previewClip?.transition ?? 'cut'}
          </p>
          {previewClip?.videoId ? (
            <YouTubePlayer
              videoId={previewClip.videoId}
              isLive={false}
              startSeconds={previewClip.startSeconds}
            />
          ) : (
            <p>No video attached for this clip.</p>
          )}
          <div className="row">
            <button disabled={previewIndex === 0} onClick={() => setPreviewIndex(previewIndex - 1)}>
              ← Previous clip
            </button>
            {!previewPlaying ? (
              <button onClick={() => setPreviewPlaying(true)}>▶ Play reel</button>
            ) : (
              <button onClick={() => setPreviewPlaying(false)}>⏸ Stop</button>
            )}
            <button
              disabled={previewIndex + 1 >= clips.length}
              onClick={() => setPreviewIndex(previewIndex + 1)}
            >
              Next clip →
            </button>
          </div>
          <p>
            <small>
              Preview plays each clip&apos;s source video at its timestamp — it does not render a
              combined file.
            </small>
          </p>
        </>
      )}

      <h3>Clips</h3>
      {clips.length === 0 ? (
        <p>No clips in this reel yet.</p>
      ) : (
        <ul className="list">
          {clips.map((clip, i) => (
            <li key={i} className="clip-row">
              <strong>
                {i + 1}. {clip.overlay || `Clip ${i + 1}`}
              </strong>{' '}
              <small>
                {clip.videoId ? 'video attached' : 'no video'} · {formatTimestamp(clip.startSeconds)} →{' '}
                {formatTimestamp(clip.endSeconds)}
              </small>
              <div className="row">
                <label className="field-label">
                  Start (s)
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={clip.startSeconds}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v >= 0) updateClip(i, { startSeconds: v });
                    }}
                  />
                </label>
                <label className="field-label">
                  End (s)
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={clip.endSeconds}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v > clip.startSeconds) updateClip(i, { endSeconds: v });
                    }}
                  />
                </label>
                <label className="field-label">
                  Transition
                  <select
                    value={clip.transition}
                    onChange={(e) => updateClip(i, { transition: e.target.value as 'cut' | 'fade' })}
                  >
                    <option value="cut">Cut</option>
                    <option value="fade">Fade</option>
                  </select>
                </label>
                <label className="field-label">
                  Text overlay
                  <input
                    value={clip.overlay}
                    onChange={(e) => updateClip(i, { overlay: e.target.value })}
                    maxLength={200}
                    placeholder="e.g. #9 — Kill"
                    className="wide"
                  />
                </label>
                <label className="field-label">
                  Slow motion
                  <input
                    type="checkbox"
                    checked={clip.slowMo}
                    onChange={(e) => updateClip(i, { slowMo: e.target.checked })}
                  />
                </label>
              </div>
              <div className="row">
                <button disabled={i === 0} onClick={() => moveClip(i, -1)}>
                  ↑ Move up
                </button>
                <button disabled={i + 1 >= clips.length} onClick={() => moveClip(i, 1)}>
                  ↓ Move down
                </button>
                <button onClick={() => setPreviewIndex(i)}>Preview this clip</button>
                <button onClick={() => setClips((prev) => prev.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3>Add highlights</h3>
      <div className="row">
        <select value={addGameId} onChange={(e) => setAddGameId(e.target.value)}>
          <option value="">Pick a game…</option>
          {props.workspace.games.map((g) => {
            const team = props.workspace.teams.find((t) => t.id === g.team_id);
            return (
              <option key={g.id} value={g.id}>
                {team?.name ?? 'Team'} vs {g.opponent || 'TBD'}
              </option>
            );
          })}
        </select>
      </div>
      {addGame && addableEvents.length === 0 && <p>No highlight events in this game yet.</p>}
      {addGame && addableEvents.length > 0 && (
        <ul className="list">
          {addableEvents.map((e) => {
            const player = props.workspace.players.find((p) => p.id === e.player_id);
            const alreadyAdded = clips.some((c) => c.eventId === e.id);
            return (
              <li key={e.id}>
                {player ? `#${player.jersey_number} ${player.name}` : 'Player'} — {e.stat_type} at{' '}
                {formatTimestamp(e.video_seconds)}
                {' '}
                <button
                  disabled={alreadyAdded}
                  onClick={() => {
                    setClips((prev) => [
                      ...prev,
                      {
                        eventId: e.id,
                        gameId: e.game_id,
                        videoId: addGame.youtube_video_id,
                        startSeconds: Math.max(0, e.video_seconds - 2),
                        endSeconds: e.video_seconds + 8,
                        transition: 'cut',
                        overlay: `${player ? `#${player.jersey_number} ${player.name}` : 'Player'} — ${e.stat_type}`,
                        slowMo: false,
                      },
                    ]);
                  }}
                >
                  {alreadyAdded ? 'Added' : 'Add to reel'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Public family-enrollment page — the ONLY thing an /enroll/<token> link
 * renders. Standalone: no app nav, no login, no editing, no workspace
 * fetch. Shows only the player's first name + team name. The family
 * enters their OWN number; nothing here ever displays an existing
 * number. A failed load means the link is bad or was regenerated — the
 * message never says which.
 */
function EnrollPage({ token }: { token: string }) {
  const [info, setInfo] = useState<EnrollInfo | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [phone, setPhone] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ optedIn: boolean; masked: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getPublicEnroll(token)
      .then((result) => {
        if (!cancelled) setInfo(result);
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (notFound) {
    return (
      <div className="page">
        <header className="org-header">
          <h1>SimpliGame</h1>
        </header>
        <h2>This enrollment link isn&rsquo;t valid.</h2>
        <p>
          The link may be mistyped, or the coach may have shared a new one. Ask the coach for
          the current enrollment link.
        </p>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="page">
        <p>Loading…</p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="page">
        <header className="org-header">
          <h1>SimpliGame</h1>
          <p className="tagline">Family text alerts</p>
        </header>
        {done.optedIn ? (
          <>
            <h2>You&rsquo;re signed up.</h2>
            <p>
              You&rsquo;ll get a text at {done.masked} when {info.player_first_name}&rsquo;s games
              go live, plus highlights alerts after games.
            </p>
          </>
        ) : (
          <>
            <h2>You&rsquo;ve opted out.</h2>
            <p>
              You won&rsquo;t get texts for {info.player_first_name}. You can sign up again any
              time with the same link.
            </p>
          </>
        )}
      </div>
    );
  }

  async function submit(optIn: boolean) {
    setError('');
    setBusy(true);
    try {
      const result = await api.submitEnroll(token, {
        phone,
        displayName: displayName.trim() || undefined,
        optIn,
      });
      setDone({ optedIn: result.opted_in, masked: result.masked_phone });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="org-header">
        <h1>SimpliGame</h1>
        <p className="tagline">Family text alerts</p>
      </header>
      <h2>
        Text alerts for {info.player_first_name} — {info.team_name}
      </h2>
      <p>
        Enter your own phone number to get a text the moment {info.player_first_name}&rsquo;s
        games go live, plus highlights alerts after games. Your number is only used for these
        alerts — it&apos;s never shown to anyone.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(true);
        }}
      >
        <div className="row">
          <label className="field-label">
            Your phone number
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(555) 123-4567"
              inputMode="tel"
              autoComplete="tel"
              required
              className="wide"
            />
          </label>
        </div>
        <div className="row">
          <label className="field-label">
            Your name (optional)
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Mom"
              maxLength={100}
              className="wide"
            />
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Opt in to texts'}
          </button>
          <button type="button" disabled={busy} onClick={() => void submit(false)}>
            Opt out of texts
          </button>
        </div>
      </form>
    </div>
  );
}
