import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, uploadFileToDriveSession } from './api';
import type { AnalysisCandidate, AnalysisJob, AuthUser, Coach, EnrollInfo, FamilyContact, Game, GameAnalysis, GameEvent, GoogleStatus, ImportedVideo, LineupRow, Organization, ParentAccount, ParentHome, Player, PlayerProfile, PlayerProfileStats, PublicProfile, PublicWatch, ReelClip, ReelProject, SheetExport, SmsLogRow, Team, Workspace } from './types';
import YouTubePlayer from './components/YouTubePlayer';
import VideoPlaceholder from './components/VideoPlaceholder';
import Icon, { type IconName } from './components/Icon';
import { downloadGameCsv } from './csv';
import './styles.css';

/** One stat button on the live screen. Scoring: `points` is how many
 *  points the rally is worth, and `side` is whose score moves. Kill /
 *  Ace / Block win the rally for us; Serve Error / Passing Error hand
 *  the rally (and the point) to the opponent — recorded with side
 *  'opponent' so the live score, box scores, and analysis all credit the
 *  point to the opponent, while the error itself stays attributed to
 *  the player who made it. */
type StatButtonDef = {
  label: string;
  points: number;
  side: 'ours' | 'opponent';
  icon: IconName;
};

/** The prototype's 8 volleyball stat buttons. */
const VOLLEYBALL_STAT_BUTTONS: StatButtonDef[] = [
  { label: 'Kill', points: 1, side: 'ours', icon: 'kill' },
  { label: 'Ace', points: 1, side: 'ours', icon: 'ace' },
  { label: 'Block', points: 1, side: 'ours', icon: 'block' },
  { label: 'Assist', points: 0, side: 'ours', icon: 'assist' },
  { label: 'Dig', points: 0, side: 'ours', icon: 'dig' },
  { label: 'Attack Attempt', points: 0, side: 'ours', icon: 'attack' },
  { label: 'Serve Error', points: 1, side: 'opponent', icon: 'serveError' },
  { label: 'Passing Error', points: 1, side: 'opponent', icon: 'passError' },
];

/** The pre-existing generic set, kept for non-volleyball teams so the
 *  app stays sport-agnostic outside volleyball. */
const GENERIC_STAT_BUTTONS: StatButtonDef[] = [
  { label: 'Kill', points: 1, side: 'ours', icon: 'kill' },
  { label: 'Ace', points: 1, side: 'ours', icon: 'ace' },
  { label: 'Block', points: 1, side: 'ours', icon: 'block' },
  { label: 'Dig', points: 0, side: 'ours', icon: 'dig' },
  { label: 'Assist', points: 0, side: 'ours', icon: 'assist' },
  { label: 'Attack attempt', points: 0, side: 'ours', icon: 'attack' },
  { label: 'Serve', points: 0, side: 'ours', icon: 'serve' },
  { label: 'Error', points: 0, side: 'ours', icon: 'error' },
];

/** Stat types that count as highlights (same list Reel Studio uses when
 *  offering events to add as clips). */
const HIGHLIGHT_STAT_TYPES = ['Kill', 'Ace', 'Block', 'Assist', 'Dig'];

type View =
  | { kind: 'home' }
  | { kind: 'live' }
  | { kind: 'liveGame'; gameId: string; returnTo: 'live' | 'teams' }
  | { kind: 'detail'; gameId: string; returnTo: 'live' | 'teams' }
  | { kind: 'teams' }
  | { kind: 'players' }
  | { kind: 'profile'; playerId: string; from: 'teams' | 'players' }
  | { kind: 'highlights' }
  | { kind: 'studio'; reelId: string | null }
  | { kind: 'exports' }
  | { kind: 'review'; gameId: string; returnTo: 'live' | 'teams' | 'highlights' }
  | { kind: 'account' }
  | { kind: 'phones' }
  | { kind: 'coaches' };

/**
 * Client-side role gating mirrors the server's permission matrix
 * (auth.ts) — it only hides/disables buttons; the server enforces
 * everything. Rank: owner (4) > head_coach (3) > assistant (2) >
 * stat_crew (1) > parent (0). Parents get a restricted shell (HOME +
 * Account only) — every canRole(..., 'stat_crew') check is false for
 * them, and their data comes from /api/parent/home, not the workspace.
 */
type ClientRole = AuthUser['role'];
const ROLE_RANK: Record<ClientRole, number> = {
  owner: 4,
  head_coach: 3,
  assistant: 2,
  stat_crew: 1,
  parent: 0,
};
function canRole(role: ClientRole, min: ClientRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

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
  // Google Drive connect returns to the app with a ?google=<flag> —
  // read it once, land on the Account screen (which shows the result),
  // and scrub it from the URL so a refresh doesn't repeat the landing.
  const [googleFlag, setGoogleFlag] = useState<string | null>(() =>
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('google')
      : null,
  );
  useEffect(() => {
    if (googleFlag) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [googleFlag]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(true);
  // Auth: null = not logged in (login/setup screen). The server enforces
  // everything — the client only renders what the server returns.
  const [me, setMe] = useState<AuthUser | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [authError, setAuthError] = useState('');

  const [playerName, setPlayerName] = useState('');
  const [playerJersey, setPlayerJersey] = useState('');
  const [playerPosition, setPlayerPosition] = useState('');
  const [youtubeUrl, setYoutubeUrl] = useState('');
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
          // Returning from the Google Drive connect flow → Account.
          if (googleFlag) setView({ kind: 'account' });
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
    view.kind === 'liveGame' || view.kind === 'detail' || view.kind === 'review'
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

  // Create-team flow (Team tab): create the team, then add the
  // starting roster one player at a time via the existing endpoints.
  // A player add that fails does NOT undo the team — the failed names
  // come back so the Team tab can say exactly who still needs adding
  // (partial success, never a silent half-roster).
  async function handleCreateTeamWithRoster(
    name: string,
    sport: string,
    newPlayers: { name: string; jersey_number: string; position: string }[],
  ): Promise<{ failedPlayers: string[] }> {
    const team = await api.createTeam(name, sport, '');
    const failedPlayers: string[] = [];
    for (const p of newPlayers) {
      try {
        await api.addPlayer(team.id, p.name, p.jersey_number, p.position);
      } catch {
        failedPlayers.push(p.name);
      }
    }
    setSelectedTeamId(team.id);
    // A refresh failure here must not read as "team creation failed"
    // — the team exists; the next load catches up.
    await refresh().catch(() => {});
    return { failedPlayers };
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

  // Go Live wizard (Live tab): "Add roster" creates a team via the
  // existing endpoint and hands it back so the wizard can select it.
  // Everything else in the wizard (create game, lineup, video,
  // publish, Go Live) calls the api directly from LiveTabScreen so a
  // mid-sequence failure surfaces in the wizard, not up here.
  async function handleCreateRoster(name: string) {
    const team = await api.createTeam(name, 'Volleyball', '');
    await refresh();
    return team;
  }

  async function handleLogEvent(stat: { label: string; points: number; side: 'ours' | 'opponent' }) {
    if (!currentGame || !selectedPlayerId) return;
    setError('');
    try {
      const result = await api.logEvent(currentGame.id, {
        player_id: selectedPlayerId,
        stat_type: stat.label,
        side: stat.side,
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

  // Manual-mode score control: a hand-managed our-side point. Mirrors
  // the existing 'Opponent point' event (player_id null, no stat
  // attached) so the score moves without polluting player stats.
  async function handleOurScores() {
    if (!currentGame) return;
    await run(async () => {
      await api.logEvent(currentGame.id, {
        player_id: null,
        stat_type: 'Our point',
        side: 'ours',
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
  // Parents get a restricted shell: HOME (their linked players) +
  // Account only. Coach tabs are not rendered for them at all, and the
  // server scopes everything they can read to their linked players.
  const isParent = me.role === 'parent';

  // Sidebar active tab: detail / live-tagging screens belong to the tab
  // they were opened from (Live or Team); a profile belongs to the tab
  // it was opened from (Team or Player Management); the Review Queue
  // belongs to the tab it was opened from (Live, Team, Highlight Builder).
  const activeTab =
    view.kind === 'home'
      ? 'home'
      : view.kind === 'live' || view.kind === 'liveGame'
        ? 'live'
        : view.kind === 'detail'
          ? view.returnTo
          : view.kind === 'review'
            ? view.returnTo
            : view.kind === 'teams'
              ? 'teams'
              : view.kind === 'players'
                ? 'players'
                : view.kind === 'profile'
                  ? view.from
                  : view.kind === 'highlights'
                    ? 'highlights'
                    : view.kind === 'studio'
                      ? 'studio'
                      : view.kind === 'exports'
                        ? 'exports'
                        : view.kind === 'coaches'
                          ? 'coaches'
                          : view.kind === 'phones'
                            ? 'phones'
                            : 'account';

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
    <div className="page">
      <header className="org-header">
        {/* Org name is display-only here — renaming lives in the
            Account screen (☰ menu → Account → Organization, owner
            only). No edit control on the banner. */}
        <div className="org-brand-row">
          <img className="org-logo" src="/icon.svg?v=3" alt="SimpliGame logo" />
          <h1>{org.name}</h1>
        </div>
        <p className="tagline">SimpliGame — Simplify the Game</p>
        <p className="sub-hint">
          Signed in as {me.name} ({me.role.replace('_', ' ')})
        </p>
        <SettingsMenu
          role={me.role}
          onOpenAccount={() => setView({ kind: 'account' })}
          onOpenPhones={() => setView({ kind: 'phones' })}
          onOpenCoaches={() => setView({ kind: 'coaches' })}
          onLogout={handleLogout}
        />
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

      <div className="app-layout">
      <nav className="side-nav">
        <button className={activeTab === 'home' ? 'selected' : ''} onClick={() => setView({ kind: 'home' })}><Icon name="home" size={18} />HOME</button>
        {!isParent && (
          <button className={activeTab === 'live' ? 'selected' : ''} onClick={() => setView({ kind: 'live' })}><Icon name="live" size={18} />Live</button>
        )}
        {!isParent && (
          <button className={activeTab === 'teams' ? 'selected' : ''} onClick={() => setView({ kind: 'teams' })}><Icon name="team" size={18} />Team</button>
        )}
        {canRole(me.role, 'head_coach') && (
          <button className={activeTab === 'players' ? 'selected' : ''} onClick={() => setView({ kind: 'players' })}>
            <Icon name="players" size={18} />Player Management
          </button>
        )}
        {canRole(me.role, 'head_coach') && (
          <button
            className={activeTab === 'highlights' ? 'selected' : ''}
            onClick={() => setView({ kind: 'highlights' })}
          >
            <Icon name="highlights" size={18} />Highlight Builder
          </button>
        )}
        {canRole(me.role, 'head_coach') && (
          <button
            className={activeTab === 'studio' ? 'selected' : ''}
            onClick={() =>
              setView({
                kind: 'studio',
                // Re-clicking the tab keeps the reel already open in
                // Studio; entering from elsewhere shows the picker.
                reelId: view.kind === 'studio' ? view.reelId : null,
              })
            }
          >
            <Icon name="studio" size={18} />Reel Studio
          </button>
        )}
        {canRole(me.role, 'head_coach') && (
          <button
            className={activeTab === 'exports' ? 'selected' : ''}
            onClick={() => setView({ kind: 'exports' })}
          >
            <Icon name="exports" size={18} />Export Center
          </button>
        )}
      </nav>

      <main className="app-main">
      {view.kind === 'home' &&
        (isParent ? (
          <ParentHomeScreen
            currentUserId={me.id}
            onOpenAccount={() => setView({ kind: 'account' })}
          />
        ) : (
          <HomeOverviewScreen
            workspace={workspace}
            role={me.role}
            onOpenGame={(gameId, returnTo) => setView({ kind: 'detail', gameId, returnTo })}
            onOpenLiveGame={(gameId, returnTo) => setView({ kind: 'liveGame', gameId, returnTo })}
            onGoTab={(tab) => setView(tab)}
            onSelectTeam={(teamId) => {
              setSelectedTeamId(teamId);
              setView({ kind: 'teams' });
            }}
          />
        ))}

      {view.kind === 'live' && (
        <LiveTabScreen
          role={me.role}
          teams={workspace.teams}
          players={workspace.players}
          games={workspace.games}
          onCreateRoster={handleCreateRoster}
          onRefresh={refresh}
          onOpenLiveGame={(gameId) => setView({ kind: 'liveGame', gameId, returnTo: 'live' })}
          onOpenDetail={(gameId) => setView({ kind: 'detail', gameId, returnTo: 'live' })}
          onOpenReview={(gameId) => setView({ kind: 'review', gameId, returnTo: 'live' })}
        />
      )}

      {view.kind === 'liveGame' && currentGame && (
        <LiveGameScreen
          role={me.role}
          game={currentGame}
          teamName={workspace.teams.find((t) => t.id === currentGame.team_id)?.name ?? 'Team'}
          teamSport={workspace.teams.find((t) => t.id === currentGame.team_id)?.sport ?? 'Volleyball'}
          players={workspace.players.filter((p) => p.team_id === currentGame.team_id)}
          lineupPlayerIds={workspace.lineups.filter((l) => l.game_id === currentGame.id).map((l) => l.player_id)}
          events={workspace.events.filter((e) => e.game_id === currentGame.id)}
          youtubeUrl={youtubeUrl}
          onYoutubeUrlChange={setYoutubeUrl}
          onSaveYouTube={async () => {
            await run(async () => {
              await api.saveYouTube(currentGame.id, youtubeUrl);
              setYoutubeUrl('');
            });
          }}
          selectedPlayerId={selectedPlayerId}
          onSelectPlayer={setSelectedPlayerId}
          onLogEvent={handleLogEvent}
          onOpponentScores={handleOpponentScores}
          onOurScores={handleOurScores}
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
          onBack={() => setView({ kind: view.returnTo })}
          onDetail={() => setView({ kind: 'detail', gameId: currentGame.id, returnTo: view.returnTo })}
        />
      )}

      {view.kind === 'detail' && currentGame && (
        <GameDetailScreen
          role={me.role}
          game={currentGame}
          teamName={workspace.teams.find((t) => t.id === currentGame.team_id)?.name ?? 'Team'}
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
            setView({ kind: 'studio', reelId: reel.id });
          }}
          onSetStatus={async (status) => run(() => api.setGameStatus(currentGame.id, status))}
          onBack={() => setView({ kind: view.returnTo })}
          onLive={() => setView({ kind: 'liveGame', gameId: currentGame.id, returnTo: view.returnTo })}
          onOpenReview={(gameId) => setView({ kind: 'review', gameId, returnTo: view.returnTo })}
        />
      )}

      {view.kind === 'teams' && (
        <TeamsTabScreen
          role={me.role}
          organization={workspace.organization}
          teams={workspace.teams}
          players={workspace.players}
          games={workspace.games}
          selectedTeamId={selectedTeamId}
          onSelectTeam={setSelectedTeamId}
          onCreateTeamWithRoster={handleCreateTeamWithRoster}
          playerName={playerName}
          onPlayerNameChange={setPlayerName}
          playerJersey={playerJersey}
          onPlayerJerseyChange={setPlayerJersey}
          playerPosition={playerPosition}
          onPlayerPositionChange={setPlayerPosition}
          onAddPlayer={handleAddPlayer}
          onOpenProfile={(playerId) => setView({ kind: 'profile', playerId, from: 'teams' })}
          onOpenLiveGame={(gameId) => setView({ kind: 'liveGame', gameId, returnTo: 'teams' })}
          onOpenDetail={(gameId) => setView({ kind: 'detail', gameId, returnTo: 'teams' })}
        />
      )}

      {view.kind === 'players' && (
        <PlayersTabScreen
          players={workspace.players}
          teams={workspace.teams}
          onOpenProfile={(playerId) => setView({ kind: 'profile', playerId, from: 'players' })}
        />
      )}

      {view.kind === 'profile' && (
        <PlayerProfileScreen
          role={me.role}
          player={workspace.players.find((p) => p.id === view.playerId)}
          onBack={() => setView({ kind: view.from })}
        />
      )}

      {view.kind === 'highlights' && (
        <HighlightBuilderScreen
          role={me.role}
          games={workspace.games}
          teams={workspace.teams}
          events={workspace.events}
          players={workspace.players}
          currentUserId={me.id}
          onOpen={(reelId) => setView({ kind: 'studio', reelId })}
          onOpenReview={(gameId) => setView({ kind: 'review', gameId, returnTo: 'highlights' })}
          onOpenAccount={() => setView({ kind: 'account' })}
        />
      )}

      {view.kind === 'studio' &&
        (view.reelId ? (
          <ReelStudioScreen
            role={me.role}
            reelId={view.reelId}
            workspace={workspace}
            onBack={() => setView({ kind: 'highlights' })}
          />
        ) : (
          <StudioPickerScreen
            games={workspace.games}
            teams={workspace.teams}
            onOpen={(reelId) => setView({ kind: 'studio', reelId })}
          />
        ))}

      {view.kind === 'exports' && <ExportCenterScreen workspace={workspace} />}

      {view.kind === 'review' && currentGame && (
        <ReviewQueueScreen
          game={currentGame}
          teamName={workspace.teams.find((t) => t.id === currentGame.team_id)?.name ?? 'Team'}
          players={workspace.players.filter((p) => p.team_id === currentGame.team_id)}
          onBack={() => setView({ kind: view.returnTo })}
          onChanged={() => void refresh()}
        />
      )}

      {view.kind === 'account' && (
        <AccountScreen
          me={me}
          onSaved={(user) => setMe(user)}
          orgName={org.name}
          onOrganizationChanged={() => void refresh()}
          googleFlag={googleFlag}
        />
      )}

      {view.kind === 'phones' && canRole(me.role, 'head_coach') && (
        <PhoneNumbersScreen
          teams={workspace.teams}
          players={workspace.players}
          onChanged={() => void refresh()}
        />
      )}

      {view.kind === 'coaches' && me.role === 'owner' && (
        <CoachesScreen teams={workspace.teams} onBack={() => setView({ kind: 'home' })} />
      )}
      </main>
      </div>
      <AppFooter />
    </div>
  );
}


/** One game row, shared by HOME / Live / Team: score, status, and entry
 *  into live tagging (Live) or the detail screen (Detail). */
function GameListItem(props: {
  game: Game;
  teamName: string;
  onLive: () => void;
  onDetail: () => void;
}) {
  return (
    <li>
      {props.teamName} vs {props.game.opponent || 'TBD'} — {props.game.our_score}:{props.game.opponent_score}{' '}
      ({props.game.mode} · {props.game.status}){' '}
      <button onClick={props.onLive}>Live</button>{' '}
      <button onClick={props.onDetail}>Detail</button>
    </li>
  );
}

/** HOME (prototype "Overview"): org identity block on top, "Your
 *  teams" directly under it, then Live now, then Upcoming games and
 *  Recent results as collapsed-by-default dropdowns (header shows the
 *  count; tap to expand), and a slim quick-links strip at the
 *  bottom. Presentation only — every number comes from the loaded
 *  workspace. For team-scoped accounts the workspace already
 *  contains only their assigned teams (the server filters by
 *  assignment), so "Your teams" is exactly the teams they are signed
 *  up for; owners see all of the org's teams. */
function HomeOverviewScreen(props: {
  workspace: Workspace;
  role: ClientRole;
  onOpenGame: (gameId: string, returnTo: 'live' | 'teams') => void;
  onOpenLiveGame: (gameId: string, returnTo: 'live' | 'teams') => void;
  onGoTab: (view: View) => void;
  onSelectTeam: (teamId: string) => void;
}) {
  const { workspace } = props;
  const org = workspace.organization;
  // Upcoming / Recent start collapsed (cleaner HOME); each header
  // still shows its count so the info stays scannable.
  const [upcomingOpen, setUpcomingOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const teamName = (teamId: string) => workspace.teams.find((t) => t.id === teamId)?.name ?? 'Team';
  const liveGames = workspace.games.filter((g) => g.status === 'live');
  const upcomingGames = workspace.games.filter((g) => g.status === 'draft');
  // Games arrive in creation order; most recent finals first.
  const recentFinals = workspace.games
    .filter((g) => g.status === 'final')
    .slice()
    .reverse()
    .slice(0, 5);
  // Fallback tiles when no logo is set: initials on the org's brand
  // colors (the org record's logo_url is used as-is when present —
  // no upload feature, no new data).
  const initials = (name: string) =>
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || '?';
  const brandTileStyle = {
    background: `linear-gradient(135deg, ${org.primary_color}, ${org.secondary_color})`,
  };
  return (
    <>
      {/* 1. Org identity block */}
      <section className="home-identity">
        <div className="home-identity-top">
          <div className="home-identity-main">
            {org.logo_url ? (
              <img className="home-identity-logo" src={org.logo_url} alt="" />
            ) : (
              <div className="home-identity-logo home-initials" style={brandTileStyle} aria-hidden="true">
                {initials(org.name)}
              </div>
            )}
            <div className="home-identity-text">
              <h2 className="home-org-name">{org.name}</h2>
            </div>
          </div>
          {/* Go Live shortcut: straight into the Live tab's wizard
              (Page 1). Same flow, no separate path — head_coach+,
              the roles that can run the wizard. */}
          {canRole(props.role, 'head_coach') && (
            <button
              className="go-live-btn btn-icon"
              onClick={() => props.onGoTab({ kind: 'live' })}
            >
              <Icon name="goLive" />Go Live
            </button>
          )}
        </div>
        <div className="stat-chips">
          <span className="stat-chip">
            <strong>{workspace.teams.length}</strong> team{workspace.teams.length === 1 ? '' : 's'}
          </span>
          <span className="stat-chip">
            <strong>{workspace.players.length}</strong> player{workspace.players.length === 1 ? '' : 's'}
          </span>
          <span className="stat-chip">
            <strong>{workspace.games.length}</strong> game{workspace.games.length === 1 ? '' : 's'}
          </span>
        </div>
      </section>

      {/* 2. Your teams — assigned teams for scoped accounts, all
          teams for the owner (the workspace is already scoped). */}
      <section>
        <h2>Your teams</h2>
        {workspace.teams.length === 0 ? (
          <p>
            {props.role === 'owner'
              ? 'No teams yet — create one on the Team tab.'
              : 'No teams assigned to you yet — ask your owner or head coach.'}
          </p>
        ) : (
          <div className="team-grid">
            {workspace.teams.map((t) => {
              const count = workspace.players.filter((p) => p.team_id === t.id).length;
              return (
                <button key={t.id} className="team-card" onClick={() => props.onSelectTeam(t.id)}>
                  <span className="team-card-tile" style={brandTileStyle} aria-hidden="true">
                    {initials(t.name)}
                  </span>
                  <span className="team-card-text">
                    <strong>{t.name}</strong>
                    <small>
                      {t.sport} · {count} player{count === 1 ? '' : 's'}
                    </small>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* 3. Games, in clean card sections */}
      {liveGames.length > 0 && (
        <section>
          <h2>Live now</h2>
          <ul className="list">
            {liveGames.map((g) => (
              <GameListItem
                key={g.id}
                game={g}
                teamName={teamName(g.team_id)}
                onLive={() => props.onOpenLiveGame(g.id, 'live')}
                onDetail={() => props.onOpenGame(g.id, 'live')}
              />
            ))}
          </ul>
        </section>
      )}

      <section>
        <button
          type="button"
          className="section-toggle"
          aria-expanded={upcomingOpen}
          onClick={() => setUpcomingOpen((o) => !o)}
        >
          <span className="section-toggle-title">Upcoming games</span>
          <span className="section-toggle-count">{upcomingGames.length}</span>
          <Icon name="chevron" className={upcomingOpen ? 'open' : undefined} />
        </button>
        {upcomingOpen &&
          (upcomingGames.length === 0 ? (
            <p>No upcoming games — create one on the Live tab.</p>
          ) : (
            <ul className="list">
              {upcomingGames.map((g) => (
                <GameListItem
                  key={g.id}
                  game={g}
                  teamName={teamName(g.team_id)}
                  onLive={() => props.onOpenLiveGame(g.id, 'live')}
                  onDetail={() => props.onOpenGame(g.id, 'live')}
                />
              ))}
            </ul>
          ))}
      </section>

      <section>
        <button
          type="button"
          className="section-toggle"
          aria-expanded={recentOpen}
          onClick={() => setRecentOpen((o) => !o)}
        >
          <span className="section-toggle-title">Recent results</span>
          <span className="section-toggle-count">{recentFinals.length}</span>
          <Icon name="chevron" className={recentOpen ? 'open' : undefined} />
        </button>
        {recentOpen &&
          (recentFinals.length === 0 ? (
            <p>No finished games yet.</p>
          ) : (
            <ul className="list">
              {recentFinals.map((g) => (
                <GameListItem
                  key={g.id}
                  game={g}
                  teamName={teamName(g.team_id)}
                  onLive={() => props.onOpenLiveGame(g.id, 'live')}
                  onDetail={() => props.onOpenGame(g.id, 'live')}
                />
              ))}
            </ul>
          ))}
      </section>

      {/* 4. Quick links */}
      <section>
        <h2>Jump to</h2>
        <div className="row">
          <button onClick={() => props.onGoTab({ kind: 'live' })} className="btn-icon"><Icon name="live" />Live</button>
          <button onClick={() => props.onGoTab({ kind: 'teams' })} className="btn-icon"><Icon name="team" />Team</button>
          {canRole(props.role, 'head_coach') && (
            <>
              <button onClick={() => props.onGoTab({ kind: 'players' })} className="btn-icon"><Icon name="players" />Player Management</button>
              <button onClick={() => props.onGoTab({ kind: 'highlights' })} className="btn-icon"><Icon name="highlights" />Highlight Builder</button>
            </>
          )}
        </div>
      </section>
    </>
  );
}

/** Live tab (prototype "Capture"): the Go Live wizard.
 *  Page 1 — pick a ROSTER (or add one, owner only); the starting-lineup
 *  picker queues right on the same page: tap exactly 6 starters, then
 *  Next. Page 2 — who we are playing (opponent) + the live link setup
 *  (video link + watch link). Go Live does two things: (1) it creates
 *  the game, applies the Page-1 lineup, attaches the video link,
 *  publishes the game so the watch link exists, and runs the Go Live
 *  transition — which texts the watch link to the enrolled family
 *  contacts of every player on the roster; and (2) it flips to the
 *  live screen for that game. Wizard state lives client-side until
 *  Go Live is pressed: abandoning the wizard mid-way creates nothing.
 *  Live-now games keep a quick resume strip; finals stay listed below. */
/** Parent HOME (role 'parent'): the restricted shell's only screen.
 *  Everything comes from GET /api/parent/home — the server scopes it
 *  to the parent's linked players, so this screen never touches the
 *  coach workspace. Per player: team, recruiting profile (read-only),
 *  stats, and the team's published games with Watch buttons (the same
 *  public watch pages families already use). Below the players: the
 *  parent's own Drive import section — imports must belong to a linked
 *  player's team and land in that team's library for the coaches. */
function ParentHomeScreen(props: {
  currentUserId: string;
  onOpenAccount: () => void;
}) {
  const [data, setData] = useState<ParentHome | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getParentHome()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load.'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <section><p>Loading…</p></section>;
  if (error) return <section><p className="error">{error}</p></section>;
  if (!data) return null;

  // The import section's team picker = the distinct teams of the
  // parent's linked players.
  const seenTeams = new Map<string, Team>();
  for (const p of data.players) {
    if (!seenTeams.has(p.team_id)) {
      seenTeams.set(p.team_id, {
        id: p.team_id,
        org_id: data.organization.id,
        name: p.team_name,
        sport: p.team_sport,
        season: '',
      });
    }
  }
  const linkedTeams = [...seenTeams.values()];

  return (
    <>
      <section>
        <h2 className="btn-icon"><Icon name="home" size={22} />My Players</h2>
        {data.players.length === 0 ? (
          <p>
            No players are linked to your account yet — your coach links your account to your
            player from their profile. Let them know if this looks wrong.
          </p>
        ) : (
          <p>Your linked players at {data.organization.name}.</p>
        )}
      </section>

      {data.players.map((p) => (
        <section key={p.id}>
          <h3>
            #{p.jersey_number} {p.name}
            {p.position ? ` · ${p.position}` : ''} — {p.team_name}
          </h3>

          {p.profile ? (
            <>
              {p.profile.bio && <p>{p.profile.bio}</p>}
              <ul>
                {p.profile.height && <li>Height: {p.profile.height}</li>}
                {p.profile.graduation_year && <li>Graduation year: {p.profile.graduation_year}</li>}
                {p.profile.positions_text && <li>Positions: {p.profile.positions_text}</li>}
                {p.profile.school && <li>School: {p.profile.school}</li>}
                {p.profile.club_team && <li>Club team: {p.profile.club_team}</li>}
              </ul>
            </>
          ) : (
            <p className="sub-hint">No recruiting profile yet — the coach builds it.</p>
          )}
          {p.profile_public_path && (
            <p>
              <a href={p.profile_public_path} target="_blank" rel="noreferrer">
                View the published recruiting profile ↗
              </a>
            </p>
          )}

          <h4>Stats</h4>
          {p.stats.gamesPlayed === 0 ? (
            <p>No recorded stats yet.</p>
          ) : (
            <>
              <p>
                {p.stats.gamesPlayed} game{p.stats.gamesPlayed === 1 ? '' : 's'} ·{' '}
                {p.stats.totalPoints} points
              </p>
              <ul>
                {Object.entries(p.stats.totals)
                  .filter(([k]) => k !== 'Substitution')
                  .map(([k, v]) => (
                    <li key={k}>
                      {k}: {v}
                    </li>
                  ))}
              </ul>
              {p.stats.highlights.length > 0 && (
                <>
                  <h4>Recent highlights</h4>
                  <ul className="list">
                    {p.stats.highlights.slice(0, 8).map((h, i) => (
                      <li key={i}>
                        {h.stat_type}
                        {h.points > 0 ? ` (+${h.points})` : ''} vs {h.opponent || 'TBD'}
                        {h.youtube_video_id
                          ? ` · at ${Math.floor(h.video_seconds / 60)}:${String(h.video_seconds % 60).padStart(2, '0')} on the game video`
                          : ''}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}

          <h4>Games — {p.team_name}</h4>
          {p.games.length === 0 ? (
            <p>No published games yet. When the coach publishes a game, it shows up here to watch.</p>
          ) : (
            <ul className="list">
              {p.games.map((g) => (
                <li key={g.id}>
                  {p.team_name} vs {g.opponent || 'TBD'} — {g.our_score}:{g.opponent_score}{' '}
                  <small>
                    {g.status === 'live' ? `● LIVE (${g.period_label})` : g.status}
                  </small>{' '}
                  <a href={g.watch_path} target="_blank" rel="noreferrer">
                    <button type="button" className="btn-icon">
                      <Icon name="eye" />
                      {g.status === 'live' ? 'Watch live' : 'Watch'}
                    </button>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      <ImportVideoSection
        role="parent"
        teams={linkedTeams}
        currentUserId={props.currentUserId}
        onOpenAccount={props.onOpenAccount}
        requireTeam
      />
    </>
  );
}

function LiveTabScreen(props: {
  role: ClientRole;
  teams: Team[];
  players: Player[];
  games: Game[];
  onCreateRoster: (name: string) => Promise<Team>;
  onRefresh: () => Promise<void>;
  onOpenLiveGame: (gameId: string) => void;
  onOpenDetail: (gameId: string) => void;
  onOpenReview: (gameId: string) => void;
}) {
  const teamName = (teamId: string) => props.teams.find((t) => t.id === teamId)?.name ?? 'Team';
  const liveGames = props.games.filter((g) => g.status === 'live');
  const finalGames = props.games.filter((g) => g.status === 'final');
  // Wizard setup (create game, set lineup, attach video, publish) is
  // head_coach+ — the same permission tier as game setup today. The
  // Go Live transition itself is assistant+, but every step before it
  // needs head_coach, so the wizard is effectively a head-coach flow.
  const canSetup = canRole(props.role, 'head_coach');
  const canPublish = canRole(props.role, 'head_coach');

  // --- Go Live wizard state (client-side until Go Live creates the game) ---
  const [step, setStep] = useState<1 | 2>(1);
  const [wizardTeamId, setWizardTeamId] = useState('');
  const [starterIds, setStarterIds] = useState<string[]>([]);
  const [opponent, setOpponent] = useState('');
  const [videoInput, setVideoInput] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [videoSaved, setVideoSaved] = useState(false);
  const [newRosterName, setNewRosterName] = useState('');
  const [busy, setBusy] = useState(false);
  const [wizardError, setWizardError] = useState('');
  // Set once Go Live has created the game. Every later step is
  // idempotent (lineup replaces, video replaces, publish reuses the
  // token), so pressing Go Live again after a mid-sequence failure
  // resumes instead of creating a duplicate game.
  const [createdGameId, setCreatedGameId] = useState<string | null>(null);
  // Shown on Page 2 when the game went live WITHOUT being published
  // (the user has no publish permission): the game is live, but family
  // texts can't send until a head coach publishes it.
  const [liveNote, setLiveNote] = useState('');
  const [copied, setCopied] = useState(false);

  // AI Vision jobs (head_coach+): per-game status for the Final list.
  // Best-effort — a failed fetch leaves the list without AI buttons
  // rather than breaking the whole Live tab.
  const [aiJobs, setAiJobs] = useState<AnalysisJob[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  useEffect(() => {
    if (!canRole(props.role, 'head_coach')) return;
    api.getAnalysisJobs().then(setAiJobs).catch(() => {});
  }, [props.role]);

  async function analyzeGame(gameId: string) {
    setAiBusy(true);
    setAiError('');
    try {
      await api.createAnalysisJob(gameId);
      setAiJobs(await api.getAnalysisJobs());
    } catch (e) {
      setAiError(e instanceof Error ? e.message : 'Could not start AI analysis');
    } finally {
      setAiBusy(false);
    }
  }

  const wizardTeam = props.teams.find((t) => t.id === wizardTeamId);
  const roster = props.players.filter((p) => p.team_id === wizardTeamId);
  const createdGame = createdGameId
    ? props.games.find((g) => g.id === createdGameId)
    : undefined;

  function pickRoster(teamId: string) {
    setWizardTeamId(teamId);
    setStarterIds([]);
    setCreatedGameId(null);
    setLiveNote('');
    setWizardError('');
  }

  function toggleStarter(playerId: string) {
    setStarterIds((prev) => {
      if (prev.includes(playerId)) return prev.filter((id) => id !== playerId);
      if (prev.length >= 6) return prev;
      return [...prev, playerId];
    });
  }

  async function addRoster(e: React.FormEvent) {
    e.preventDefault();
    if (!newRosterName.trim()) return;
    setBusy(true);
    setWizardError('');
    try {
      const team = await props.onCreateRoster(newRosterName.trim());
      setNewRosterName('');
      pickRoster(team.id);
    } catch (err) {
      setWizardError(err instanceof Error ? err.message : 'Could not add roster');
    } finally {
      setBusy(false);
    }
  }

  // The video link is "saved" into wizard state (not the server — the
  // game doesn't exist until Go Live). Editing the input afterwards
  // un-saves it, so Go Live never attaches a stale link by accident.
  function saveVideoLink() {
    if (!videoInput.trim()) return;
    setVideoUrl(videoInput.trim());
    setVideoSaved(true);
  }

  const nextOk = !!wizardTeam && starterIds.length === 6;
  const goLiveOk = opponent.trim() !== '' && videoSaved;

  async function goLive() {
    if (!wizardTeam || !goLiveOk) return;
    setBusy(true);
    setWizardError('');
    try {
      let gameId = createdGameId;
      if (!gameId) {
        const game = await api.createGame(
          wizardTeamId,
          opponent.trim(),
          wizardTeam.sport || 'Volleyball',
          'live',
        );
        gameId = game.id;
        setCreatedGameId(gameId);
      }
      await api.setLineup(gameId, starterIds);
      await api.saveYouTube(gameId, videoUrl);
      let published = createdGame?.published ?? false;
      if (canPublish) {
        const res = await api.publishGame(gameId);
        published = !!res.game.published;
      }
      // The Go Live transition texts families the watch link
      // server-side — but only for a published game (the text IS the
      // link), and it goes to the enrolled contacts of every player
      // on this roster's team.
      if (createdGame?.status !== 'live') {
        await api.setGameStatus(gameId, 'live');
      }
      await props.onRefresh().catch(() => {});
      if (published) {
        // (2) flip to the live screen, 6 starters on court.
        props.onOpenLiveGame(gameId);
      } else {
        // Live, but unpublished: proceed, with the note in plain sight.
        setLiveNote(
          'You are live — but this game is not published, so family texts did not send (the text is the watch link). A head coach can publish it from Game Detail, then families can be texted the link.',
        );
      }
    } catch (e) {
      setWizardError(
        e instanceof Error
          ? `${e.message} If the game was already created, pressing Go Live again picks up where it left off.`
          : 'Could not go live',
      );
    } finally {
      setBusy(false);
    }
  }

  async function unpublishCreated() {
    if (!createdGameId) return;
    setBusy(true);
    setWizardError('');
    try {
      await api.unpublishGame(createdGameId);
      await props.onRefresh().catch(() => {});
    } catch (e) {
      setWizardError(e instanceof Error ? e.message : 'Could not unpublish');
    } finally {
      setBusy(false);
    }
  }

  async function regenerateCreated() {
    if (!createdGameId) return;
    setBusy(true);
    setWizardError('');
    try {
      await api.revokeGameLink(createdGameId);
      await props.onRefresh().catch(() => {});
    } catch (e) {
      setWizardError(e instanceof Error ? e.message : 'Could not regenerate the link');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section>
        <h2>Live</h2>
        {liveGames.length > 0 && (
          <>
            <h3>Live now</h3>
            <ul className="list">
              {liveGames.map((g) => (
                <GameListItem
                  key={g.id}
                  game={g}
                  teamName={teamName(g.team_id)}
                  onLive={() => props.onOpenLiveGame(g.id)}
                  onDetail={() => props.onOpenDetail(g.id)}
                />
              ))}
            </ul>
          </>
        )}

        <div className="setup-panel wizard">
          <h3>Start Live Game</h3>
          <p className="sub-hint">
            Step {step} of 2 — {step === 1 ? 'Roster & starting lineup' : 'Live link & opponent'}
          </p>

          {step === 1 && (
            <>
              <h4>Pick a roster</h4>
              <ul className="list">
                {props.teams.map((t) => (
                  <li key={t.id}>
                    <button
                      className={t.id === wizardTeamId ? 'selected' : ''}
                      onClick={() => pickRoster(t.id)}
                    >
                      {t.name} ({props.players.filter((p) => p.team_id === t.id).length} players)
                    </button>
                  </li>
                ))}
              </ul>
              {props.teams.length === 0 && (
                <p>No rosters yet — add one below or on the Team tab.</p>
              )}
              {props.role === 'owner' && (
                <form className="row" onSubmit={addRoster}>
                  <input
                    value={newRosterName}
                    onChange={(e) => setNewRosterName(e.target.value)}
                    placeholder="New roster name"
                    maxLength={100}
                  />
                  <button type="submit" disabled={!newRosterName.trim() || busy} className="btn-icon">
                    <Icon name="plus" />Add roster
                  </button>
                </form>
              )}
              {!canSetup && (
                <p className="sub-hint">
                  A head coach sets up a new live game (roster, lineup, and links). Once a
                  game is set up, an assistant can start it from the game itself.
                </p>
              )}

              {wizardTeam && (
                <>
                  <h4>Starting lineup — {wizardTeam.name}</h4>
                  <p>
                    {starterIds.length} of 6 selected. Tap 6 players to start the game — they
                    open on court on the live screen.
                  </p>
                  {roster.length < 6 ? (
                    <p>Add at least 6 players to this roster first (Team tab).</p>
                  ) : (
                    <div className="cards">
                      {roster.map((p) => (
                        <button
                          key={p.id}
                          className={`card ${starterIds.includes(p.id) ? 'selected' : ''}`}
                          onClick={() => toggleStarter(p.id)}
                          disabled={!canSetup}
                        >
                          <strong>#{p.jersey_number}</strong>
                          <br />
                          {p.name}
                          <br />
                          <small>{p.position}</small>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}

              {wizardError && <p className="error">{wizardError}</p>}
              <div className="row wizard-actions">
                <button
                  disabled={!nextOk}
                  onClick={() => {
                    setWizardError('');
                    setStep(2);
                  }}
                  className="btn-icon"
                >
                  Next<Icon name="next" />
                </button>
                {!nextOk && (
                  <span className="sub-hint">
                    {!wizardTeam
                      ? 'Pick a roster to continue.'
                      : `Pick ${6 - starterIds.length} more starter${6 - starterIds.length === 1 ? '' : 's'} to continue.`}
                  </span>
                )}
              </div>
            </>
          )}

          {step === 2 && wizardTeam && (
            <>
              <p>
                <strong>{wizardTeam.name}</strong> · Starting 6 set ✓{' '}
                <button
                  type="button"
                  onClick={() => {
                    setWizardError('');
                    setStep(1);
                  }}
                  className="btn-icon"
                >
                  <Icon name="back" />Back
                </button>
              </p>

              <h4>Who are we playing?</h4>
              <div className="row">
                <input
                  value={opponent}
                  onChange={(e) => setOpponent(e.target.value)}
                  placeholder="Opponent"
                  className="wide"
                  disabled={!canSetup}
                />
              </div>

              <h4>Video link</h4>
              {videoSaved ? (
                <p>✓ Video link saved. Replace it below if needed — editing un-saves it.</p>
              ) : (
                <p>Add the YouTube link for this game&apos;s stream or video.</p>
              )}
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveVideoLink();
                }}
              >
                <input
                  value={videoInput}
                  onChange={(e) => {
                    setVideoInput(e.target.value);
                    setVideoSaved(false);
                  }}
                  placeholder="Paste YouTube link or video ID"
                  className="wide"
                  disabled={!canSetup}
                />
                <button
                  type="submit"
                  disabled={!videoInput.trim() || videoSaved}
                  className="btn-icon"
                >
                  <Icon name="check" />Save video link
                </button>
              </form>

              <h4>Watch link</h4>
              {createdGame?.published && createdGame.publish_token ? (
                <>
                  <p>Published — anyone with the link can watch this game live. No login needed.</p>
                  <div className="row">
                    <input
                      readOnly
                      value={`${window.location.origin}/watch/${createdGame.publish_token}`}
                      className="wide"
                      onFocus={(e) => e.target.select()}
                    />
                    <button
                      type="button"
                      className="btn-icon"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(
                            `${window.location.origin}/watch/${createdGame.publish_token}`,
                          );
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        } catch {
                          // Clipboard unavailable — the input above is
                          // selected on focus, so it can be copied manually.
                        }
                      }}
                    >
                      <Icon name="copy" />{copied ? 'Copied!' : 'Copy link'}
                    </button>
                  </div>
                  {canPublish && (
                    <div className="row">
                      <button onClick={() => void unpublishCreated()} disabled={busy} className="btn-icon"><Icon name="eyeOff" />Unpublish</button>
                      <button onClick={() => void regenerateCreated()} disabled={busy} className="btn-icon"><Icon name="refresh" />Regenerate link</button>
                    </div>
                  )}
                </>
              ) : (
                <p>
                  Going live publishes this game and creates its shareable watch link.
                  Families of every player on the roster get the link by text automatically
                  the moment you go live.
                  {!canPublish &&
                    ' Publishing needs a head coach — without it the game still goes live, but the family texts cannot send.'}
                </p>
              )}

              <h4>Go Live</h4>
              {liveNote ? (
                <>
                  <p className="mock-note">{liveNote}</p>
                  <div className="row wizard-actions">
                    <button
                      onClick={() => createdGameId && props.onOpenLiveGame(createdGameId)}
                      className="btn-icon"
                    >
                      <Icon name="goLive" />Open the live game
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {!goLiveOk && (
                    <p className="sub-hint">
                      To go live:{' '}
                      {opponent.trim() === '' ? 'name the opponent' : ''}
                      {opponent.trim() === '' && !videoSaved ? ' + ' : ''}
                      {!videoSaved ? 'save the video link' : ''}.
                    </p>
                  )}
                  {canRole(props.role, 'assistant') ? (
                    <div className="row wizard-actions">
                      <button
                        disabled={!goLiveOk || busy}
                        onClick={() => void goLive()}
                        className="btn-icon"
                      >
                        <Icon name="goLive" />
                        {busy ? 'Going live…' : 'Go Live'}
                      </button>
                    </div>
                  ) : (
                    <p className="sub-hint">An assistant or head coach starts the game.</p>
                  )}
                </>
              )}
              {wizardError && <p className="error">{wizardError}</p>}
            </>
          )}
        </div>

        <h3>Final</h3>
        {finalGames.length === 0 ? (
          <p>No finished games.</p>
        ) : (
          <ul className="list">
            {finalGames.map((g) => {
              // AI Vision (head_coach+): per-game job status + the
              // Analyze video / Review Queue button. No video → the
              // button is disabled with a note.
              const aiJob = aiJobs.find((j) => j.game_id === g.id);
              return (
                <li key={g.id}>
                  {teamName(g.team_id)} vs {g.opponent || 'TBD'} — {g.our_score}:{g.opponent_score}{' '}
                  ({g.mode} · {g.status}){' '}
                  <button onClick={() => props.onOpenLiveGame(g.id)}>Live</button>{' '}
                  <button onClick={() => props.onOpenDetail(g.id)}>Detail</button>{' '}
                  {canRole(props.role, 'head_coach') && (
                    <>
                      {aiJob && (
                        <small>
                          AI: {aiJob.status === 'pending' ? 'Queued' : aiJob.status === 'processing' ? 'Processing' : aiJob.status === 'done' ? 'Done' : 'Failed'}{' '}
                        </small>
                      )}
                      {aiJob?.status === 'done' ? (
                        <button onClick={() => props.onOpenReview(g.id)} className="btn-icon"><Icon name="ai" />Review Queue</button>
                      ) : (
                        <button
                          disabled={!g.youtube_video_id || aiJob?.status === 'pending' || aiJob?.status === 'processing' || aiBusy}
                          onClick={() => void analyzeGame(g.id)}
                          className="btn-icon"
                        >
                          <Icon name="ai" />
                          {aiJob?.status === 'pending'
                            ? 'AI: Queued…'
                            : aiJob?.status === 'processing'
                              ? 'AI: Processing…'
                              : aiJob?.status === 'failed'
                                ? 'Retry AI analysis'
                                : 'Analyze video'}
                        </button>
                      )}
                      {!g.youtube_video_id && <small> Attach a video first.</small>}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {aiError && <p className="error">{aiError}</p>}
      </section>
    </>
  );
}

/** Team tab: holds ALL rosters — team list, per-team roster
 *  management, and that team's games. Roster edits stay head_coach+
 *  (server enforces; the client only hides the forms). */
/** One player row in the create-team form (Team tab). Rows with a
 *  blank name are skipped on save — the team can be created empty
 *  and filled in later from the roster's own add-player form. */
type DraftPlayer = { name: string; jersey: string; position: string };

const EMPTY_DRAFT_PLAYER: DraftPlayer = { name: '', jersey: '', position: '' };

function TeamsTabScreen(props: {
  role: ClientRole;
  organization: Organization;
  teams: Team[];
  players: Player[];
  games: Game[];
  selectedTeamId: string;
  onSelectTeam: (id: string) => void;
  onCreateTeamWithRoster: (
    name: string,
    sport: string,
    newPlayers: { name: string; jersey_number: string; position: string }[],
  ) => Promise<{ failedPlayers: string[] }>;
  playerName: string;
  onPlayerNameChange: (v: string) => void;
  playerJersey: string;
  onPlayerJerseyChange: (v: string) => void;
  playerPosition: string;
  onPlayerPositionChange: (v: string) => void;
  onAddPlayer: (e: React.FormEvent) => void;
  onOpenProfile: (playerId: string) => void;
  onOpenLiveGame: (gameId: string) => void;
  onOpenDetail: (gameId: string) => void;
}) {
  // --- Create-team flow (owner only): an in-tab view that replaces
  // the browse view. Nothing reaches the server until "Create Team"
  // is pressed, so Cancel leaves nothing behind. ---
  const [creating, setCreating] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamSport, setNewTeamSport] = useState('Volleyball');
  const [draftPlayers, setDraftPlayers] = useState<DraftPlayer[]>([{ ...EMPTY_DRAFT_PLAYER }]);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState('');
  // Outcome of the last create, shown above the strip back in browse
  // mode: plain success, or partial success naming the players whose
  // adds failed (the team itself was created either way).
  const [notice, setNotice] = useState('');
  const [noticePartial, setNoticePartial] = useState(false);

  const selectedTeam = props.teams.find((t) => t.id === props.selectedTeamId);
  const roster = props.players.filter((p) => p.team_id === props.selectedTeamId);
  const teamGames = props.games.filter((g) => g.team_id === props.selectedTeamId);
  const teamName = (teamId: string) => props.teams.find((t) => t.id === teamId)?.name ?? 'Team';
  const playerCount = (teamId: string) => props.players.filter((p) => p.team_id === teamId).length;
  // Same initials-tile treatment as HOME's team cards: the org's
  // brand gradient behind the team's initials.
  const initials = (name: string) =>
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || '?';
  const brandTileStyle = {
    background: `linear-gradient(135deg, ${props.organization.primary_color}, ${props.organization.secondary_color})`,
  };

  function resetDraft() {
    setNewTeamName('');
    setNewTeamSport('Volleyball');
    setDraftPlayers([{ ...EMPTY_DRAFT_PLAYER }]);
    setCreateError('');
  }

  function openCreate() {
    resetDraft();
    setNotice('');
    setCreating(true);
  }

  function cancelCreate() {
    resetDraft();
    setCreating(false);
  }

  function updateDraftPlayer(index: number, patch: Partial<DraftPlayer>) {
    setDraftPlayers((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = newTeamName.trim();
    if (!name || createBusy) return;
    // Only rows with a name are included; blank rows are ignored and
    // zero players is fine (the roster can be filled in later).
    const included = draftPlayers
      .map((p) => ({
        name: p.name.trim(),
        jersey_number: p.jersey.trim(),
        position: p.position.trim(),
      }))
      .filter((p) => p.name !== '');
    setCreateBusy(true);
    setCreateError('');
    try {
      const { failedPlayers } = await props.onCreateTeamWithRoster(
        name,
        newTeamSport.trim() || 'Volleyball',
        included,
      );
      // The App handler has already selected the new team — land on it.
      resetDraft();
      setCreating(false);
      if (failedPlayers.length > 0) {
        setNoticePartial(true);
        setNotice(
          `Team "${name}" was created, but these players could not be added: ${failedPlayers.join(', ')}. You can add them from the roster below.`,
        );
      } else {
        setNoticePartial(false);
        setNotice(
          included.length > 0
            ? `Team "${name}" created with ${included.length} player${included.length === 1 ? '' : 's'}.`
            : `Team "${name}" created.`,
        );
      }
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Could not create the team.');
    } finally {
      setCreateBusy(false);
    }
  }

  if (creating) {
    return (
      <section>
        <h2 className="btn-icon">
          <Icon name="team" size={22} />
          Create team
        </h2>
        <form onSubmit={submitCreate} className="create-team-form">
          <label className="field-label">
            Team name
            <input
              value={newTeamName}
              onChange={(e) => setNewTeamName(e.target.value)}
              placeholder="e.g. Llamas 14U"
              required
              autoFocus
            />
          </label>
          <label className="field-label">
            Sport
            <input
              value={newTeamSport}
              onChange={(e) => setNewTeamSport(e.target.value)}
              placeholder="Volleyball"
            />
          </label>

          <h3>Players</h3>
          <p className="sub-hint">
            Optional — add the starting roster now, or leave the rows blank and add
            players later from the Team tab.
          </p>
          {draftPlayers.map((p, i) => (
            <div className="row draft-player-row" key={i}>
              <input
                className="draft-name"
                value={p.name}
                onChange={(e) => updateDraftPlayer(i, { name: e.target.value })}
                placeholder="Player name"
                aria-label="Player name"
              />
              <input
                className="draft-jersey"
                value={p.jersey}
                onChange={(e) => updateDraftPlayer(i, { jersey: e.target.value })}
                placeholder="#"
                aria-label="Jersey number"
              />
              <input
                className="draft-position"
                value={p.position}
                onChange={(e) => updateDraftPlayer(i, { position: e.target.value })}
                placeholder="Position"
                aria-label="Position"
              />
              <button
                type="button"
                className="btn-icon"
                onClick={() => setDraftPlayers((prev) => prev.filter((_, j) => j !== i))}
                aria-label="Remove this player row"
                title="Remove this player row"
              >
                <Icon name="x" />
              </button>
            </div>
          ))}
          <div className="row">
            <button
              type="button"
              className="btn-icon"
              onClick={() => setDraftPlayers((prev) => [...prev, { ...EMPTY_DRAFT_PLAYER }])}
            >
              <Icon name="plus" />
              Add another player
            </button>
          </div>

          {createError && <p className="error">{createError}</p>}
          <div className="row wizard-actions">
            <button
              type="submit"
              disabled={createBusy || !newTeamName.trim()}
              className="btn-icon"
            >
              <Icon name="check" />
              {createBusy ? 'Creating…' : 'Create Team'}
            </button>
            <button type="button" onClick={cancelCreate} disabled={createBusy}>
              Cancel
            </button>
          </div>
        </form>
      </section>
    );
  }

  return (
    <>
      <section>
        <h2>Teams</h2>
        {notice && <p className={noticePartial ? 'mock-note' : 'notice-ok'}>{notice}</p>}
        <div className="team-strip-wrap">
          <div className="team-strip">
            {props.teams.map((t) => (
              <button
                key={t.id}
                className={`team-card team-strip-card${t.id === props.selectedTeamId ? ' selected' : ''}`}
                onClick={() => {
                  setNotice('');
                  props.onSelectTeam(t.id);
                }}
              >
                <span className="team-card-tile" style={brandTileStyle} aria-hidden="true">
                  {initials(t.name)}
                </span>
                <span className="team-card-text">
                  <strong>{t.name}</strong>
                  <small>
                    {t.sport} · {playerCount(t.id)} player{playerCount(t.id) === 1 ? '' : 's'}
                  </small>
                </span>
              </button>
            ))}
            {props.teams.length === 0 && (
              <p className="sub-hint team-strip-empty">
                {props.role === 'owner'
                  ? 'No teams yet — create your first one.'
                  : 'No teams assigned to you yet.'}
              </p>
            )}
          </div>
          {props.role === 'owner' && (
            <button className="team-strip-create btn-icon" onClick={openCreate}>
              <Icon name="plus" />
              Create Team
            </button>
          )}
        </div>
      </section>

      {selectedTeam && (
        <section>
          <h2>Roster — {selectedTeam.name}</h2>
          {canRole(props.role, 'head_coach') && (
            <form onSubmit={props.onAddPlayer} className="row">
              <input
                value={props.playerName}
                onChange={(e) => props.onPlayerNameChange(e.target.value)}
                placeholder="Player name"
                required
              />
              <input
                value={props.playerJersey}
                onChange={(e) => props.onPlayerJerseyChange(e.target.value)}
                placeholder="#"
              />
              <input
                value={props.playerPosition}
                onChange={(e) => props.onPlayerPositionChange(e.target.value)}
                placeholder="Position"
              />
              <button type="submit">Add player</button>
            </form>
          )}
          <ul className="list">
            {roster.map((p) => (
              <li key={p.id}>
                #{p.jersey_number} {p.name} — {p.position}{' '}
                <button onClick={() => props.onOpenProfile(p.id)}>Profile</button>
              </li>
            ))}
          </ul>
          {roster.length === 0 && <p>No players on this roster yet.</p>}

          <h3>Games — {selectedTeam.name}</h3>
          {teamGames.length === 0 ? (
            <p>No games yet — create one on the Live tab.</p>
          ) : (
            <ul className="list">
              {teamGames.map((g) => (
                <GameListItem
                  key={g.id}
                  game={g}
                  teamName={teamName(g.team_id)}
                  onLive={() => props.onOpenLiveGame(g.id)}
                  onDetail={() => props.onOpenDetail(g.id)}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

/** Player Management (prototype "Profile"): every player across all
 *  teams, grouped by team, each opening the full recruiting profile
 *  (bio + measurables editing, auto stats, highlights, publish
 *  controls). Head-coach+ only — the sidebar hides this tab below that,
 *  and the server enforces profile edits. */
function PlayersTabScreen(props: {
  players: Player[];
  teams: Team[];
  onOpenProfile: (playerId: string) => void;
}) {
  return (
    <section>
      <h2>Player Management</h2>
      <p className="sub-hint">
        Every player across all teams. Open a profile to edit bio + measurables, see auto
        stats and highlights, and manage the public link.
      </p>
      {props.teams.map((t) => {
        const members = props.players.filter((p) => p.team_id === t.id);
        if (members.length === 0) return null;
        return (
          <div key={t.id}>
            <h3>{t.name}</h3>
            <ul className="list">
              {members.map((p) => (
                <li key={p.id}>
                  #{p.jersey_number} {p.name} — {p.position}{' '}
                  <button onClick={() => props.onOpenProfile(p.id)}>Open profile</button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {props.players.length === 0 && <p>No players yet — add players on the Team tab.</p>}
    </section>
  );
}

/** Highlight Builder: the single home for ALL highlight building — the
 *  reel library, automated Auto Reel builds, and manual building in
 *  Reel Studio. Replaces the old Reels tab. */
function HighlightBuilderScreen(props: {
  role: ClientRole;
  games: Game[];
  teams: Team[];
  events: GameEvent[];
  players: Player[];
  currentUserId: string;
  onOpen: (reelId: string) => void;
  onOpenReview: (gameId: string) => void;
  onOpenAccount: () => void;
}) {
  return (
    <>
      <section>
        <h2 className="btn-icon"><Icon name="highlights" size={22} />Highlight Builder</h2>
        <p>
          Automated builds, the reel library, and manual building in Reel Studio — all
          highlights live here.
        </p>
      </section>
      <AutoReelSection games={props.games} teams={props.teams} onOpen={props.onOpen} />
      <AiQueuePickerSection games={props.games} teams={props.teams} role={props.role} onOpenReview={props.onOpenReview} />
      <EventsByPlayerSection
        games={props.games}
        teams={props.teams}
        events={props.events}
        players={props.players}
        onOpen={props.onOpen}
      />
      <ImportVideoSection
        role={props.role}
        teams={props.teams}
        currentUserId={props.currentUserId}
        onOpenAccount={props.onOpenAccount}
      />
      <ReelsListScreen role={props.role} games={props.games} teams={props.teams} onOpen={props.onOpen} />
    </>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** HTML5 player for an imported Drive video. Fetches a short-lived
 *  media URL, seeks to startSeconds once metadata loads, and (when
 *  endSeconds is given) pauses there — the same clip-window behavior
 *  the YouTube preview approximates. Used by the library Play button
 *  and the Reel Studio preview. */
function ImportedVideoPlayer(props: {
  videoId: string;
  startSeconds?: number;
  endSeconds?: number;
  onTimeUpdate?: (seconds: number) => void;
}) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl('');
    setError('');
    api
      .getImportedMediaUrl(props.videoId)
      .then((r) => {
        if (!cancelled) setUrl(r.url);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not load this video.');
        }
      });
    return () => {
      cancelled = true;
    };
    // startSeconds/endSeconds are read at seek time, not fetch triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.videoId]);

  if (error) {
    return (
      <div className="yt-error">
        <strong>This video couldn’t play here.</strong>
        <p>{error}</p>
      </div>
    );
  }
  if (!url) {
    return (
      <div className="yt-wrap">
        <div className="yt-loading">Loading video…</div>
      </div>
    );
  }
  return (
    <div className="yt-wrap">
      <video
        ref={videoRef}
        className="drive-video"
        src={url}
        controls
        preload="metadata"
        playsInline
        onLoadedMetadata={() => {
          const v = videoRef.current;
          if (v && props.startSeconds) v.currentTime = props.startSeconds;
        }}
        onTimeUpdate={() => {
          const v = videoRef.current;
          if (!v) return;
          props.onTimeUpdate?.(v.currentTime);
          if (props.endSeconds && v.currentTime >= props.endSeconds) v.pause();
        }}
      />
    </div>
  );
}

/** Import video: files that were NOT streamed in the app, uploaded to
 *  the coach's OWN Google Drive (drive.file scope — the file lives in
 *  their Drive, tied to them). The browser sends the file straight to
 *  Google via a resumable session; the server never sees the bytes. */
function ImportVideoSection(props: {
  role: ClientRole;
  teams: Team[];
  currentUserId: string;
  onOpenAccount: () => void;
  /** Parents: every import must belong to one of their linked
   *  players' teams (the server enforces it too) — no "No team". */
  requireTeam?: boolean;
}) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [videos, setVideos] = useState<ImportedVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [teamId, setTeamId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [s, v] = await Promise.all([api.getGoogleStatus(), api.listImportedVideos()]);
      setStatus(s);
      setVideos(v);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load imported videos.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Parent mode: preselect the (usually single) linked team so the
  // required team is never an extra step.
  useEffect(() => {
    if (props.requireTeam && !teamId && props.teams.length > 0) {
      setTeamId(props.teams[0].id);
    }
  }, [props.requireTeam, props.teams, teamId]);

  async function handleUpload() {
    if (!file) return;
    setError('');
    setSuccess('');
    setUploading(true);
    setProgress(0);
    try {
      const init = await api.initImportedUpload({
        title: title.trim() || file.name.replace(/\.[^.]+$/, ''),
        team_id: teamId || null,
        mime_type: file.type,
        size_bytes: file.size,
      });
      const { driveFileId } = await uploadFileToDriveSession(init.uploadUrl, file, setProgress);
      const video = await api.completeImportedUpload(init.videoId, driveFileId);
      setSuccess(`“${video.title}” imported into your Google Drive.`);
      setFile(null);
      setTitle('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.');
      await load();
    } finally {
      setUploading(false);
      setProgress(0);
    }
  }

  async function handleDelete(video: ImportedVideo) {
    setError('');
    setSuccess('');
    try {
      await api.deleteImportedVideo(video.id);
      if (playingId === video.id) setPlayingId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete the import.');
    }
  }

  return (
    <section>
      <h2 className="btn-icon"><Icon name="video" size={22} />Import video</h2>
      <p>
        Add game film that wasn&apos;t streamed in the app. Imports upload to <strong>your own
        Google Drive</strong> (a “SimpliGame” folder) and become clip sources in Reel Studio.
      </p>
      {error && <p className="error">{error}</p>}
      {success && <p>{success}</p>}
      {loading ? (
        <p>Loading…</p>
      ) : status?.setupRequired ? (
        <p className="mock-note">
          Drive import is not set up yet — the server needs migration 011 (ask the owner).
        </p>
      ) : status && !status.connected ? (
        <>
          <p>Connect Google Drive first — it takes one sign-in, and imports live in your Drive, not the app&apos;s.</p>
          <button onClick={props.onOpenAccount} className="btn-icon">
            <Icon name="video" />Connect Google Drive in Account
          </button>
        </>
      ) : (
        <>
          <div className="row">
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                if (f && !title.trim()) setTitle(f.name.replace(/\.[^.]+$/, ''));
              }}
            />
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title (e.g. Scrimmage vs West — full game)"
              maxLength={150}
              className="wide"
            />
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              {!props.requireTeam && <option value="">No team</option>}
              {props.requireTeam && props.teams.length === 0 && (
                <option value="">No linked team</option>
              )}
              {props.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button
              disabled={!file || uploading || (props.requireTeam && !teamId)}
              onClick={handleUpload}
              className="btn-icon"
            >
              <Icon name="export" />
              {uploading ? 'Uploading…' : 'Import video'}
            </button>
          </div>
          {uploading && (
            <div className="upload-progress-row">
              <div className="upload-progress">
                <div
                  className="upload-progress-fill"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
              <span>{Math.round(progress * 100)}%</span>
            </div>
          )}
          {videos.length === 0 ? (
            <p>No imported videos yet.</p>
          ) : (
            <ul className="list">
              {videos.map((v) => {
                const team = props.teams.find((t) => t.id === v.team_id);
                const canDelete = v.mine || props.role === 'owner';
                return (
                  <li key={v.id}>
                    <strong>{v.title}</strong>{' '}
                    <small>
                      {team ? `${team.name} · ` : ''}
                      {formatBytes(v.size_bytes)} ·{' '}
                      {v.ready ? 'in your Drive' : 'upload incomplete'}
                    </small>{' '}
                    {v.ready && (
                      <button onClick={() => setPlayingId(playingId === v.id ? null : v.id)}>
                        {playingId === v.id ? 'Hide' : 'Play'}
                      </button>
                    )}{' '}
                    {canDelete && (
                      <button onClick={() => void handleDelete(v)}>Delete</button>
                    )}
                    {playingId === v.id && (
                      <ImportedVideoPlayer key={v.id} videoId={v.id} />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** Automated builds: pick a game + preset, get a draft reel in Studio. */
function AutoReelSection(props: {
  games: Game[];
  teams: Team[];
  onOpen: (reelId: string) => void;
}) {
  const [gameId, setGameId] = useState('');
  const [preset, setPreset] = useState<'hype' | 'clean' | 'simple'>('hype');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <section>
      <h2 className="btn-icon"><Icon name="buildReel" size={22} />Auto Reel — automated builds</h2>
      <p>
        One tap builds a draft reel from a game&apos;s highlights (best plays first) and opens
        it in Reel Studio for tweaking.
      </p>
      <div className="row">
        <select value={gameId} onChange={(e) => setGameId(e.target.value)}>
          <option value="">Pick a game…</option>
          {props.games.map((g) => {
            const team = props.teams.find((t) => t.id === g.team_id);
            return (
              <option key={g.id} value={g.id}>
                {team?.name ?? 'Team'} vs {g.opponent || 'TBD'}
              </option>
            );
          })}
        </select>
        <select value={preset} onChange={(e) => setPreset(e.target.value as 'hype' | 'clean' | 'simple')}>
          <option value="hype">Hype — fades + overlays</option>
          <option value="clean">Clean — cuts + overlays</option>
          <option value="simple">Simple — cuts, no overlays</option>
        </select>
        <button
          disabled={busy || !gameId}
          className="btn-icon"
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const reel = await api.autoReel(gameId, preset);
              props.onOpen(reel.id);
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Auto Reel failed');
            } finally {
              setBusy(false);
            }
          }}
        >
          <Icon name="buildReel" />{busy ? 'Building…' : 'Build Auto Reel'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/** Events by player: pick a game, see its recorded events grouped by the
 *  player they are assigned to, and build a reel from one player's
 *  highlights. This is where the Live screen's events feed moved —
 *  the Live screen stays lean (matchup → video → tracker → box score)
 *  and events live here, next to the reel flows that use them. */
function EventsByPlayerSection(props: {
  games: Game[];
  teams: Team[];
  events: GameEvent[];
  players: Player[];
  onOpen: (reelId: string) => void;
}) {
  const [gameId, setGameId] = useState('');
  const [busyPlayerId, setBusyPlayerId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const game = props.games.find((g) => g.id === gameId);
  const gameEvents = useMemo(
    () => (game ? props.events.filter((e) => e.game_id === game.id) : []),
    [game, props.events],
  );

  // Group by assigned player; events with no player (opponent points,
  // Game started/ended) go under "Other" so nothing is lost.
  const groups = useMemo(() => {
    const byPlayer = new Map<string, GameEvent[]>();
    const other: GameEvent[] = [];
    for (const e of gameEvents) {
      if (e.player_id) {
        const arr = byPlayer.get(e.player_id) ?? [];
        arr.push(e);
        byPlayer.set(e.player_id, arr);
      } else {
        other.push(e);
      }
    }
    return { byPlayer, other };
  }, [gameEvents]);

  // Build a reel from one player's highlight events — same clip shape
  // Reel Studio's "Add highlights" uses — then open it in Studio.
  async function buildReelForPlayer(player: Player, events: GameEvent[]) {
    if (!game) return;
    const highlightEvents = events.filter((e) => HIGHLIGHT_STAT_TYPES.includes(e.stat_type));
    if (highlightEvents.length === 0) return;
    setBusyPlayerId(player.id);
    setError('');
    try {
      const reel = await api.createReel({
        name: `#${player.jersey_number} ${player.name} — Highlights`,
        game_id: game.id,
        clips: highlightEvents.map((e) => ({
          eventId: e.id,
          gameId: e.game_id,
          videoId: game.youtube_video_id,
          importedVideoId: null,
          playerTag: null,
          startSeconds: Math.max(0, e.video_seconds - 2),
          endSeconds: e.video_seconds + 8,
          transition: 'cut' as const,
          overlay: `#${player.jersey_number} ${player.name} — ${e.stat_type}`,
          slowMo: false,
        })),
      });
      props.onOpen(reel.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to build reel');
    } finally {
      setBusyPlayerId(null);
    }
  }

  return (
    <section>
      <h2 className="btn-icon"><Icon name="players" size={22} />Events by player</h2>
      <p>
        A game&apos;s recorded events, grouped by the player they belong to. Build a reel
        from one player&apos;s highlights — it opens in Reel Studio for tweaking.
      </p>
      <div className="row">
        <select value={gameId} onChange={(e) => setGameId(e.target.value)}>
          <option value="">Pick a game…</option>
          {props.games.map((g) => {
            const team = props.teams.find((t) => t.id === g.team_id);
            return (
              <option key={g.id} value={g.id}>
                {team?.name ?? 'Team'} vs {g.opponent || 'TBD'}
              </option>
            );
          })}
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      {game && gameEvents.length === 0 && <p>No events recorded in this game yet.</p>}
      {game && gameEvents.length > 0 && (
        <>
          {[...groups.byPlayer.entries()].map(([playerId, events]) => {
            const player = props.players.find((p) => p.id === playerId);
            const highlightCount = events.filter((e) =>
              HIGHLIGHT_STAT_TYPES.includes(e.stat_type),
            ).length;
            return (
              <div key={playerId}>
                <h3>
                  #{player?.jersey_number ?? '?'} {player?.name ?? 'Unknown player'} —{' '}
                  {events.length} event{events.length === 1 ? '' : 's'}
                </h3>
                <ul className="list">
                  {events.map((e) => (
                    <li key={e.id}>
                      {e.stat_type}
                      {e.points > 0 && e.side === 'ours' ? ` (+${e.points})` : ''}
                      {e.points > 0 && e.side === 'opponent' ? ' (opp +1)' : ''} · at{' '}
                      {formatTimestamp(e.video_seconds)}
                    </li>
                  ))}
                </ul>
                <div className="row">
                  <button
                    disabled={busyPlayerId === playerId || highlightCount === 0}
                    className="btn-icon"
                    onClick={() => player && buildReelForPlayer(player, events)}
                  >
                    <Icon name="buildReel" />
                    {busyPlayerId === playerId
                      ? 'Building…'
                      : highlightCount === 0
                        ? 'No highlight clips for this player'
                        : `Build reel (${highlightCount} clip${highlightCount === 1 ? '' : 's'})`}
                  </button>
                </div>
              </div>
            );
          })}
          {groups.other.length > 0 && (
            <div>
              <h3>Other — {groups.other.length} event{groups.other.length === 1 ? '' : 's'}</h3>
              <ul className="list">
                {groups.other.map((e) => (
                  <li key={e.id}>
                    {e.stat_type}
                    {e.points > 0 && e.side === 'ours' ? ` (+${e.points})` : ''}
                    {e.points > 0 && e.side === 'opponent' ? ' (opp +1)' : ''} · at{' '}
                    {formatTimestamp(e.video_seconds)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** AI Vision Phase 1 — job status + Analyze video button for one
 *  finished game. The coach creates the job; the local worker on
 *  their own machine polls for it, processes the video locally, and
 *  posts candidates back. Nothing here runs inference — the server
 *  only stores jobs + candidates. Renders nothing for unfinished
 *  games (AI analysis runs on finished games only). */
function AiAnalysisSection(props: {
  game: Game;
  role: ClientRole;
  onOpenReview: (gameId: string) => void;
}) {
  const [job, setJob] = useState<AnalysisJob | null>(null);
  const [candidates, setCandidates] = useState<AnalysisCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  async function load() {
    try {
      const result = await api.getAnalysisJob(props.game.id);
      setJob(result.job);
      setCandidates(result.candidates);
      setLoaded(true);
    } catch {
      // Best-effort: the section hides on failure rather than
      // breaking the whole detail screen.
    }
  }

  useEffect(() => {
    if (props.game.status === 'final') void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.game.id, props.game.status]);

  if (props.game.status !== 'final') return null;
  if (!canRole(props.role, 'head_coach')) return null;

  const pendingCount = candidates.filter((c) => c.status === 'pending').length;
  const reviewedCount = candidates.length - pendingCount;

  async function analyze() {
    setBusy(true);
    setError('');
    try {
      await api.createAnalysisJob(props.game.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start AI analysis');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h3 className="btn-icon"><Icon name="ai" size={22} />AI Vision</h3>
      <p className="sub-hint">
        The local worker on your own machine analyzes the game video and proposes
        candidate plays — you confirm each with one tap. Nothing is published as
        AI-detected without your yes.
      </p>
      {!loaded ? (
        <p>Loading AI status…</p>
      ) : !job ? (
        <>
          <p>No AI analysis yet for this game.</p>
          <button
            disabled={!props.game.youtube_video_id || busy}
            onClick={() => void analyze()}
            className="btn-icon"
          >
            <Icon name="ai" />{busy ? 'Starting…' : 'Analyze video'}
          </button>
          {!props.game.youtube_video_id && <p><small>Attach a video first.</small></p>}
        </>
      ) : job.status === 'pending' || job.status === 'processing' ? (
        <>
          <p>
            AI analysis: <strong>{job.status === 'pending' ? 'Queued' : 'Processing'}</strong> — waiting
            for the local worker. Run the worker on your Dell (see README).
          </p>
          <button onClick={() => void load()}>Refresh status</button>
        </>
      ) : job.status === 'failed' ? (
        <>
          <p className="error">AI analysis failed{job.error ? `: ${job.error}` : '.'}</p>
          <button disabled={!props.game.youtube_video_id || busy} onClick={() => void analyze()} className="btn-icon">
            <Icon name="ai" />{busy ? 'Starting…' : 'Retry AI analysis'}
          </button>
        </>
      ) : candidates.length === 0 ? (
        <>
          <p>AI analysis is done — no candidates found. Tag manually.</p>
          <button disabled={!props.game.youtube_video_id || busy} onClick={() => void analyze()} className="btn-icon">
            <Icon name="ai" />{busy ? 'Starting…' : 'Re-analyze video'}
          </button>
        </>
      ) : (
        <>
          <p>
            AI analysis: <strong>Done</strong> — {pendingCount} candidate{pendingCount === 1 ? '' : 's'} to
            review, {reviewedCount} reviewed.
          </p>
          <button onClick={() => props.onOpenReview(props.game.id)} className="btn-icon">
            <Icon name="ai" />Open Review Queue
          </button>{' '}
          <button disabled={busy} onClick={() => void analyze()}>
            {busy ? 'Starting…' : 'Re-analyze video'}
          </button>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/** AI Vision entry inside Highlight Builder: pick a finished game,
 *  see its job status, and open its Review Queue. */
function AiQueuePickerSection(props: {
  games: Game[];
  teams: Team[];
  role: ClientRole;
  onOpenReview: (gameId: string) => void;
}) {
  const [gameId, setGameId] = useState('');
  if (!canRole(props.role, 'head_coach')) return null;
  const finals = props.games.filter((g) => g.status === 'final');
  const game = props.games.find((g) => g.id === gameId);
  return (
    <section>
      <h2 className="btn-icon"><Icon name="ai" size={22} />AI Vision — Review Queue</h2>
      <p>
        Post-game AI proposes candidate plays for a finished game — confirm each with
        one tap. Pick a game to see its analysis status.
      </p>
      <div className="row">
        <select value={gameId} onChange={(e) => setGameId(e.target.value)}>
          <option value="">Pick a finished game…</option>
          {finals.map((g) => {
            const team = props.teams.find((t) => t.id === g.team_id);
            return (
              <option key={g.id} value={g.id}>
                {team?.name ?? 'Team'} vs {g.opponent || 'TBD'}
              </option>
            );
          })}
        </select>
      </div>
      {finals.length === 0 && <p>No finished games yet.</p>}
      {game && <AiAnalysisSection game={game} role={props.role} onOpenReview={props.onOpenReview} />}
    </section>
  );
}

/** Stat labels the coach can pick when correcting a candidate. The
 *  volleyball set is canonical; the server accepts the full list. */
const AI_CORRECT_STATS = [
  'Kill', 'Ace', 'Block', 'Assist', 'Dig', 'Attack Attempt', 'Serve Error', 'Passing Error',
];

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.8) return 'High confidence';
  if (confidence >= 0.5) return 'Medium confidence';
  return 'Low confidence';
}

/** AI Vision Phase 1 — Review Queue. One card per pending candidate:
 *  a 6-second clip, the proposed stat + player, and a confidence
 *  badge. Confirm writes a NORMAL event (same pipeline as a manual
 *  tap); Correct lets the coach change the stat and/or player first;
 *  Skip writes nothing. Reviewed candidates list below so the coach
 *  can see what was already decided. */
function ReviewQueueScreen(props: {
  game: Game;
  teamName: string;
  players: Player[];
  onBack: () => void;
  onChanged: () => void;
}) {
  const [job, setJob] = useState<AnalysisJob | null>(null);
  const [candidates, setCandidates] = useState<AnalysisCandidate[]>([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [correctStat, setCorrectStat] = useState('');
  const [correctPlayerId, setCorrectPlayerId] = useState('');

  async function load() {
    try {
      const result = await api.getAnalysisJob(props.game.id);
      setJob(result.job);
      setCandidates(result.candidates);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the Review Queue');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.game.id]);

  const pending = candidates.filter((c) => c.status === 'pending');
  const reviewed = candidates.filter((c) => c.status !== 'pending');
  const playerName = (id: string | null) =>
    props.players.find((p) => p.id === id)?.name ?? 'Unknown player';
  const playerLabel = (id: string | null) => {
    const p = props.players.find((x) => x.id === id);
    return p ? `#${p.jersey_number} ${p.name}` : 'No player proposed';
  };

  async function confirm(c: AnalysisCandidate) {
    setBusyId(c.id);
    setError('');
    try {
      await api.confirmCandidate(c.id, {});
      await load();
      props.onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not confirm');
    } finally {
      setBusyId(null);
    }
  }

  async function confirmCorrected(c: AnalysisCandidate) {
    setBusyId(c.id);
    setError('');
    try {
      await api.confirmCandidate(c.id, {
        stat: correctStat || undefined,
        player_id: correctPlayerId === '' ? undefined : correctPlayerId === 'none' ? null : correctPlayerId,
      });
      setCorrectingId(null);
      await load();
      props.onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not confirm correction');
    } finally {
      setBusyId(null);
    }
  }

  async function skip(c: AnalysisCandidate) {
    setBusyId(c.id);
    setError('');
    try {
      await api.skipCandidate(c.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not skip');
    } finally {
      setBusyId(null);
    }
  }

  function startCorrect(c: AnalysisCandidate) {
    setCorrectingId(c.id);
    setCorrectStat(c.proposed_stat);
    setCorrectPlayerId(c.proposed_player_id ?? 'none');
  }

  return (
    <section>
      <button onClick={props.onBack} className="btn-icon"><Icon name="back" />Back</button>
      <h2 className="btn-icon"><Icon name="ai" size={22} />AI Review Queue</h2>
      <p>
        {props.teamName} vs {props.game.opponent || 'TBD'} · Final {props.game.our_score}:
        {props.game.opponent_score}
      </p>
      <p className="sub-hint">
        AI proposes — you decide. Confirm writes a normal stat event, exactly like a
        manual tap. Correct changes the stat and/or player first. Skip writes nothing.
      </p>
      {error && <p className="error">{error}</p>}
      {!job ? (
        <p>No AI analysis yet for this game — run “Analyze video” first.</p>
      ) : job.status === 'pending' || job.status === 'processing' ? (
        <p>
          AI analysis is {job.status === 'pending' ? 'queued' : 'processing'} — waiting for the
          local worker. Run the worker on your Dell, then refresh.
        </p>
      ) : job.status === 'failed' ? (
        <p className="error">AI analysis failed{job.error ? `: ${job.error}` : '.'}</p>
      ) : candidates.length === 0 ? (
        <p>No candidates found — tag manually.</p>
      ) : (
        <>
          <p>
            {pending.length} candidate{pending.length === 1 ? '' : 's'} to review · {reviewed.length}{' '}
            reviewed
          </p>
          {pending.map((c) => (
            <div key={c.id} className="candidate-card">
              {props.game.youtube_video_id && (
                <YouTubePlayer
                  videoId={props.game.youtube_video_id}
                  isLive={false}
                  startSeconds={Math.max(0, Math.floor(c.clip_start_sec))}
                />
              )}
              <p>
                <strong>{c.proposed_stat}</strong> · {playerLabel(c.proposed_player_id)}
              </p>
              <p className="sub-hint">
                At {Math.floor(c.timestamp_sec)}s · {confidenceLabel(c.confidence)} (
                {Math.round(c.confidence * 100)}%)
              </p>
              {correctingId === c.id ? (
                <div className="row">
                  <select value={correctStat} onChange={(e) => setCorrectStat(e.target.value)}>
                    {AI_CORRECT_STATS.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <select value={correctPlayerId} onChange={(e) => setCorrectPlayerId(e.target.value)}>
                    <option value="none">No player</option>
                    {props.players.map((p) => (
                      <option key={p.id} value={p.id}>#{p.jersey_number} {p.name}</option>
                    ))}
                  </select>
                  <button disabled={busyId === c.id} onClick={() => void confirmCorrected(c)} className="btn-icon">
                    <Icon name="check" />{busyId === c.id ? 'Saving…' : 'Confirm corrected'}
                  </button>
                  <button disabled={busyId === c.id} onClick={() => setCorrectingId(null)}>Cancel</button>
                </div>
              ) : (
                <div className="row">
                  <button disabled={busyId === c.id} onClick={() => void confirm(c)} className="btn-icon">
                    <Icon name="check" />{busyId === c.id ? 'Saving…' : 'Confirm'}
                  </button>
                  <button disabled={busyId === c.id} onClick={() => startCorrect(c)}>Correct</button>
                  <button disabled={busyId === c.id} onClick={() => void skip(c)}>Skip</button>
                </div>
              )}
            </div>
          ))}
          {reviewed.length > 0 && (
            <>
              <h3>Reviewed</h3>
              <ul className="list">
                {reviewed.map((c) => (
                  <li key={c.id}>
                    {c.status === 'skipped'
                      ? `Skipped — ${c.proposed_stat} (${playerLabel(c.proposed_player_id)})`
                      : `${c.status === 'corrected' ? 'Corrected' : 'Confirmed'} — ${c.final_stat ?? c.proposed_stat} (${playerName(c.final_player_id ?? c.proposed_player_id)})`}
                    {' '}· at {Math.floor(c.timestamp_sec)}s
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

/** Small footer on the app shell, login, and setup screens: IP notice +
 *  links to the privacy policy and terms. Static server pages open in a
 *  new tab so the app's SPA state is never disturbed. */
function AppFooter() {
  return (
    <footer className="app-footer">
      © 2026 SimpliGame ·{' '}
      <a href="/privacy" target="_blank" rel="noreferrer">Privacy</a> ·{' '}
      <a href="/terms" target="_blank" rel="noreferrer">Terms</a>
    </footer>
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
      <div className="org-brand-row"><img className="org-logo" src="/icon.svg?v=3" alt="SimpliGame logo" /><h1>SimpliGame</h1></div>
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
      <AppFooter />
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
      <div className="org-brand-row"><img className="org-logo" src="/icon.svg?v=3" alt="SimpliGame logo" /><h1>SimpliGame</h1></div>
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
      <AppFooter />
    </div>
  );
}

/** Upper-right header menu (hamburger): Account / Phone Numbers
 *  (head_coach+) / Coaches (owner only) / Logout. Owns no logic of its
 *  own — it relocates the controls that used to live in the header and
 *  sidebar. Closes on outside click, Esc, or choosing an item. */
function SettingsMenu(props: {
  role: ClientRole;
  onOpenAccount: () => void;
  onOpenPhones: () => void;
  onOpenCoaches: () => void;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function choose(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <div className="settings-menu" ref={rootRef}>
      <button
        type="button"
        className="settings-toggle"
        aria-label="Settings menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="menu" size={22} />
      </button>
      {open && (
        <div className="settings-panel" role="menu">
          <button type="button" role="menuitem" onClick={() => choose(props.onOpenAccount)}>
            <Icon name="players" size={18} />Account
          </button>
          {canRole(props.role, 'head_coach') && (
            <button type="button" role="menuitem" onClick={() => choose(props.onOpenPhones)}>
              <Icon name="phone" size={18} />Phone Numbers
            </button>
          )}
          {props.role === 'owner' && (
            <button type="button" role="menuitem" onClick={() => choose(props.onOpenCoaches)}>
              <Icon name="coaches" size={18} />Coaches
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => choose(props.onLogout)}>
            <Icon name="logout" size={18} />Logout
          </button>
        </div>
      )}
    </div>
  );
}

/** Account screen: edit your own name/email (PATCH /api/auth/me — the
 *  server edits only your own record and keeps the session alive), with
 *  the self-service change-password form housed below the info form.
 *  Owners also get the Organization section: the org rename control
 *  that used to sit on the header banner (moved here; the endpoint,
 *  PATCH /api/organization, is owner-only 'org' and unchanged). */
function AccountScreen({
  me,
  onSaved,
  orgName,
  onOrganizationChanged,
  googleFlag,
}: {
  me: AuthUser;
  onSaved: (user: AuthUser) => void;
  orgName: string;
  onOrganizationChanged: () => void;
  googleFlag: string | null;
}) {
  const [name, setName] = useState(me.name);
  const [email, setEmail] = useState(me.email);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');
    setBusy(true);
    try {
      const user = await api.updateMe(name.trim(), email.trim());
      onSaved(user);
      setSuccess('Account info saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save account info.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section>
        <h2>Account</h2>
        <p className="sub-hint">
          Signed in as {me.name} ({me.role.replace('_', ' ')})
        </p>
        <form onSubmit={handleSubmit}>
          <div className="row">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
              required
              maxLength={100}
              autoComplete="name"
            />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              required
              autoComplete="email"
            />
            <button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
          {error && <p className="error">{error}</p>}
          {success && <p>{success}</p>}
        </form>
      </section>
      {me.role === 'owner' && (
        <OrganizationSection orgName={orgName} onChanged={onOrganizationChanged} />
      )}
      <GoogleDriveSection googleFlag={googleFlag} />
      <section>
        <h2>Password</h2>
        <ChangePasswordForm />
      </section>
    </>
  );
}

/** Result banners for the Google connect round-trip (?google=<flag>). */
const GOOGLE_FLAG_MESSAGES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'Google Drive connected.' },
  denied: { ok: false, text: 'Google Drive connection was cancelled — nothing was connected.' },
  failed: { ok: false, text: 'Something went wrong connecting Google Drive — please try again.' },
  'not-configured': {
    ok: false,
    text: 'Google Drive is not configured on the server yet — ask the owner to finish the setup.',
  },
  session: {
    ok: false,
    text: 'Your sign-in changed during the Google connect — sign in and try connecting again.',
  },
  'login-required': { ok: false, text: 'Sign in first, then connect Google Drive.' },
  setup: {
    ok: false,
    text: 'Drive import is not set up yet — the server needs migration 011 (ask the owner).',
  },
};

/** Per-user Google Drive connection (video import storage). Imported
 *  videos live in the coach's OWN Drive under a "SimpliGame" folder,
 *  with drive.file scope — the app can only touch files it created.
 *  Connect is a full-page trip to Google and back (?google= flag);
 *  this section shows the outcome and the live connection status. */
function GoogleDriveSection({ googleFlag }: { googleFlag: string | null }) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.getGoogleStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to check Google Drive status.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleDisconnect() {
    setBusy(true);
    setError('');
    try {
      await api.disconnectGoogle();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disconnect Google Drive.');
    } finally {
      setBusy(false);
    }
  }

  const flag = googleFlag ? GOOGLE_FLAG_MESSAGES[googleFlag] : undefined;

  return (
    <section>
      <h2>Google Drive</h2>
      <p>
        Imported videos are stored in <strong>your own</strong> Google Drive (in a “SimpliGame”
        folder) — tied to you, not the app. SimpliGame can only access files it created there.
      </p>
      {flag && <p className={flag.ok ? '' : 'error'}>{flag.text}</p>}
      {error && <p className="error">{error}</p>}
      {status === null ? (
        <p>Checking connection…</p>
      ) : status.setupRequired ? (
        <p className="mock-note">
          Drive import is not set up yet — the server needs migration 011 (ask the owner).
        </p>
      ) : status.connected ? (
        <div className="row">
          <span>
            Connected{status.email ? ` as ${status.email}` : ''}
          </span>
          <button type="button" onClick={handleDisconnect} disabled={busy}>
            {busy ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn-icon"
          onClick={() => {
            window.location.href = '/api/auth/google/connect';
          }}
        >
          <Icon name="video" />Connect Google Drive
        </button>
      )}
    </section>
  );
}

/** Organization rename (owner only): the same control that used to sit
 *  on the header banner — name input + save via PATCH /api/organization
 *  (the server enforces owner-only 'org'). On success the workspace
 *  refreshes so the header picks up the new name. */
function OrganizationSection({
  orgName,
  onChanged,
}: {
  orgName: string;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(orgName);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');
    setBusy(true);
    try {
      await api.renameOrganization(name);
      setEditing(false);
      setSuccess('Organization name saved.');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename organization.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Organization</h2>
      {editing ? (
        <form
          className="row"
          onSubmit={handleSubmit}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Organization name"
            maxLength={100}
            required
            autoFocus
          />
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setName(orgName);
              setError('');
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <div className="row">
          <span>{orgName}</span>
          <button
            type="button"
            className="org-edit-btn"
            aria-label="Rename organization"
            onClick={() => {
              setName(orgName);
              setEditing(true);
              setSuccess('');
            }}
          >
            ✏️ Rename
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {success && <p>{success}</p>}
    </section>
  );
}

/** Self-service password change, housed in the Account screen. */
function ChangePasswordForm() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (next !== confirm) {
      setError('New passwords do not match.');
      return;
    }
    if (next.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    try {
      await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setSuccess('Password changed. Your other sessions were signed out.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password.');
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          setError('');
          setSuccess('');
        }}
      >
        Change password
      </button>
      {open && (
        <form onSubmit={handleSubmit}>
          <div className="row">
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              placeholder="Current password"
              required
              autoComplete="current-password"
            />
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              placeholder="New password (8+ characters)"
              required
              autoComplete="new-password"
            />
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Confirm new password"
              required
              autoComplete="new-password"
            />
            <button type="submit">Change password</button>
          </div>
          {error && <p className="error">{error}</p>}
          {success && <p>{success}</p>}
        </form>
      )}
    </div>
  );
}

/** Phone Numbers (head_coach+, from the header ☰ menu): the central hub
 *  for the family text-alert enrollment system — the same per-player
 *  enroll links + masked contacts managed in the player profile, for
 *  every player at once, grouped by team. Families still self-enroll
 *  their own numbers via the link; the coach never types numbers here,
 *  and numbers are only ever shown MASKED. */
function PhoneNumbersScreen(props: { teams: Team[]; players: Player[]; onChanged: () => void }) {
  return (
    <>
      <section>
        <h2>Phone Numbers</h2>
        <p>
          Family text alerts for every team. Send each player&apos;s family their enrollment
          link — families sign themselves up with their own number, and numbers stay masked
          here.
        </p>
      </section>
      {props.teams.map((team) => {
        const teamPlayers = props.players.filter((p) => p.team_id === team.id);
        if (teamPlayers.length === 0) return null;
        return (
          <section key={team.id}>
            <h3>{team.name}</h3>
            {teamPlayers.map((player) => (
              <PlayerPhoneCard key={player.id} player={player} onChanged={props.onChanged} />
            ))}
          </section>
        );
      })}
      {props.players.length === 0 && (
        <section>
          <p>No players yet — add players on the Team tab first.</p>
        </section>
      )}
    </>
  );
}

/** One player's enrollment management: the enroll link (generate / copy /
 *  regenerate — the existing per-player token flow) and the enrolled
 *  family contacts, masked, with remove. */
function PlayerPhoneCard(props: { player: Player; onChanged: () => void }) {
  const playerId = props.player.id;
  const [token, setToken] = useState<string | null>(props.player.enroll_token);
  const [contacts, setContacts] = useState<FamilyContact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(true);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setToken(props.player.enroll_token);
  }, [props.player.enroll_token]);

  const loadContacts = useCallback(async () => {
    setContacts(await api.getFamily(playerId));
  }, [playerId]);

  useEffect(() => {
    loadContacts()
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load contacts'))
      .finally(() => setLoadingContacts(false));
  }, [loadContacts]);

  async function run(action: () => Promise<unknown>) {
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  }

  async function generateLink() {
    await run(async () => {
      const result = await api.generateEnrollToken(playerId);
      setToken(result.enrollToken);
      props.onChanged();
    });
  }

  const link = token ? `${window.location.origin}/enroll/${token}` : null;

  return (
    <div>
      <h4>
        #{props.player.jersey_number} {props.player.name} — {props.player.position}
      </h4>
      {error && <p className="error">{error}</p>}
      {link ? (
        <>
          <div className="row">
            <input readOnly value={link} className="wide" onFocus={(e) => e.target.select()} />
            <button
              type="button"
              className="btn-icon"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(link);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  // Clipboard unavailable — the input above is selected on
                  // focus, so the coach can copy it manually.
                }
              }}
            >
              <Icon name="copy" />{copied ? 'Copied!' : 'Copy link'}
            </button>
            <button type="button" className="btn-icon" onClick={generateLink}>
              <Icon name="refresh" />Regenerate link
            </button>
          </div>
          <p>
            <small>Regenerating the link kills the old one.</small>
          </p>
        </>
      ) : (
        <div className="row">
          <span>No enrollment link yet.</span>
          <button type="button" className="btn-icon" onClick={generateLink}>
            <Icon name="plus" />Create enrollment link
          </button>
        </div>
      )}
      {loadingContacts ? (
        <p>Loading contacts…</p>
      ) : contacts.length === 0 ? (
        <p>No family contacts yet.</p>
      ) : (
        <ul className="list">
          {contacts.map((c) => (
            <li key={c.id}>
              {c.display_name ? `${c.display_name} — ` : ''}
              {c.masked_phone} {c.opted_in ? '(opted in)' : '(opted out)'}{' '}
              <button
                type="button"
                onClick={() =>
                  run(async () => {
                    await api.removeFamily(c.id);
                    await loadContacts();
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
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
  const [resetState, setResetState] = useState<Record<string, { next: string; confirm: string }>>({});
  const [resetMessage, setResetMessage] = useState('');

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
    setResetMessage('');
    try {
      await api.deleteCoach(coach.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove coach');
    }
  }

  async function handleResetPassword(coach: Coach) {
    const r = resetState[coach.id];
    if (!r) return;
    setError('');
    setResetMessage('');
    if (r.next !== r.confirm) {
      setError('New passwords do not match.');
      return;
    }
    if (r.next.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    try {
      await api.resetCoachPassword(coach.id, r.next);
      setResetState((prev) => {
        const nextState = { ...prev };
        delete nextState[coach.id];
        return nextState;
      });
      setResetMessage(
        `Password reset for ${coach.name}. Share the new password with them out-of-band — they will need to log in again.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password');
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
      {resetMessage && <p>{resetMessage}</p>}
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
                      <button type="button" onClick={() => void handleRemove(c)}>Remove</button>{' '}
                      <button
                        type="button"
                        onClick={() =>
                          setResetState((prev) =>
                            prev[c.id]
                              ? (() => {
                                  const nextState = { ...prev };
                                  delete nextState[c.id];
                                  return nextState;
                                })()
                              : { ...prev, [c.id]: { next: '', confirm: '' } },
                          )
                        }
                      >
                        Reset password
                      </button>
                      {resetState[c.id] && (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            void handleResetPassword(c);
                          }}
                        >
                          <div className="row">
                            <input
                              type="password"
                              value={resetState[c.id].next}
                              onChange={(e) =>
                                setResetState((prev) => ({
                                  ...prev,
                                  [c.id]: { ...prev[c.id], next: e.target.value },
                                }))
                              }
                              placeholder="New password (8+ characters)"
                              required
                              autoComplete="new-password"
                            />
                            <input
                              type="password"
                              value={resetState[c.id].confirm}
                              onChange={(e) =>
                                setResetState((prev) => ({
                                  ...prev,
                                  [c.id]: { ...prev[c.id], confirm: e.target.value },
                                }))
                              }
                              placeholder="Confirm new password"
                              required
                              autoComplete="new-password"
                            />
                            <button type="submit">Set new password</button>{' '}
                            <button
                              type="button"
                              onClick={() =>
                                setResetState((prev) => {
                                  const nextState = { ...prev };
                                  delete nextState[c.id];
                                  return nextState;
                                })
                              }
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      )}
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

/** Volleyball hitting % renders as .333 (no leading zero), negatives as -.100. */
function formatHittingPct(v: number): string {
  const s = v.toFixed(3);
  if (s.startsWith('0.')) return s.slice(1);
  if (s.startsWith('-0.')) return '-' + s.slice(2);
  return s;
}

function LiveGameScreen(props: {
  role: ClientRole;
  game: Game;
  teamName: string;
  teamSport: string;
  players: Player[];
  lineupPlayerIds: string[];
  events: { player_id: string | null; stat_type: string; points: number; side: string }[];
  youtubeUrl: string;
  onYoutubeUrlChange: (v: string) => void;
  onSaveYouTube: () => void;
  selectedPlayerId: string | null;
  onSelectPlayer: (id: string) => void;
  onLogEvent: (stat: { label: string; points: number; side: 'ours' | 'opponent' }) => void;
  onOpponentScores: () => void;
  onOurScores: () => void;
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
  // YouTube dropdown under the video: collapsed by default.
  const [youtubeOpen, setYoutubeOpen] = useState(false);
  // Stat mode: automatic (default) — one stat tap auto-updates score,
  // box score, player totals, and derived stats. Manual ("Keep stats
  // manually") — stat taps record the play but do NOT move the score;
  // the coach manages the score by hand with the score buttons below.
  // Per-game-session only — not persisted to the server.
  const [manualMode, setManualMode] = useState(false);
  // Stat buttons stay up even with no player selected — tapping one
  // with no selection shows this hint + briefly highlights the
  // on-court cards instead of recording anything.
  const [statHint, setStatHint] = useState(false);
  useEffect(() => {
    if (!statHint) return;
    const t = setTimeout(() => setStatHint(false), 1800);
    return () => clearTimeout(t);
  }, [statHint]);

  function handleStatClick(s: { label: string; points: number; side: 'ours' | 'opponent' }) {
    if (!selected) {
      setStatHint(true);
      return;
    }
    // Manual mode: record the play (player + type + timestamp) but do
    // NOT auto-update the score — points: 0 keeps the server's running
    // score untouched while the event still lands.
    props.onLogEvent(manualMode ? { ...s, points: 0 } : s);
  }

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

  // Box score: per-player counts by stat type, plus points — same
  // computation as Game Detail, so both screens always agree. Points
  // only count for our side: a Serve Error / Passing Error is recorded
  // with side 'opponent' and its point belongs to the opponent, not
  // to the player who made the error. Hitting % = (Kills − Errors) /
  // Attack Attempts; Errors = the error types the stat set tracks
  // (Serve + Passing + generic Error). Null when the player has no
  // attempts yet — no dividing by zero.
  const boxScore = useMemo(() => {
    const byPlayer = new Map<
      string,
      { name: string; stats: Record<string, number>; points: number; hitting: number | null }
    >();
    for (const e of props.events) {
      if (!e.player_id) continue;
      const player = props.players.find((p) => p.id === e.player_id);
      const entry = byPlayer.get(e.player_id) ?? {
        name: player?.name ?? 'Unknown',
        stats: {},
        points: 0,
        hitting: null,
      };
      entry.stats[e.stat_type] = (entry.stats[e.stat_type] ?? 0) + 1;
      if (e.side === 'ours') entry.points += e.points;
      byPlayer.set(e.player_id, entry);
    }
    for (const entry of byPlayer.values()) {
      const kills = entry.stats['Kill'] ?? 0;
      const attempts = (entry.stats['Attack Attempt'] ?? 0) + (entry.stats['Attack attempt'] ?? 0);
      const errors =
        (entry.stats['Serve Error'] ?? 0) +
        (entry.stats['Passing Error'] ?? 0) +
        (entry.stats['Error'] ?? 0);
      entry.hitting = attempts > 0 ? (kills - errors) / attempts : null;
    }
    return [...byPlayer.values()];
  }, [props.events, props.players]);

  // Stat set follows the TEAM's sport: the prototype's 8 volleyball
  // buttons for volleyball teams, the generic set for every other sport.
  const statButtons =
    props.teamSport.toLowerCase() === 'volleyball' ? VOLLEYBALL_STAT_BUTTONS : GENERIC_STAT_BUTTONS;

  // Role gates (server enforces; the client only hides what the role
  // may not do): stat crew tags stats + undo only — no subs, no Go Live
  // / End Game.
  const canAssistant = canRole(props.role, 'assistant');

  return (
    <section>
      <button onClick={props.onBack} className="btn-icon"><Icon name="back" />All games</button>{' '}
      <button onClick={props.onDetail} className="btn-icon"><Icon name="eye" />Game detail</button>

      {/* 1. Matchup header ABOVE the video: teams + live score + status. */}
      <div className="live-matchup">
        <div className="live-matchup-row">
          <span className="live-matchup-team">{props.teamName}</span>
          <span className="live-matchup-score">
            {props.game.our_score} — {props.game.opponent_score}
          </span>
          <span className="live-matchup-team">{props.game.opponent || 'TBD'}</span>
        </div>
        <div className="live-matchup-meta">
          {props.game.status === 'live' && <span className="live-badge">● LIVE</span>}
          {props.game.status === 'draft' && (
            <span className="live-badge live-badge-upcoming">Upcoming</span>
          )}
          {props.game.status === 'final' && (
            <span className="live-badge live-badge-final">Final</span>
          )}
          <span className="sub-hint">{props.game.period_label}</span>
        </div>
        <div className="row">
          {canAssistant && props.game.status === 'draft' && (
            <button onClick={() => props.onSetStatus('live')} className="btn-icon"><Icon name="goLive" />Go Live</button>
          )}
          {canAssistant && props.game.status === 'live' && (
            <button onClick={() => props.onSetStatus('final')} className="btn-icon"><Icon name="endGame" />End Game</button>
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
      </div>

      {/* 2. Video screen directly under the matchup header. */}
      {props.game.youtube_video_id ? (
        <YouTubePlayer videoId={props.game.youtube_video_id} isLive={props.game.status === 'live'} />
      ) : (
        <VideoPlaceholder
          title={`${props.teamName} vs ${props.game.opponent || 'TBD'}`}
          subtitle={`${props.game.status === 'live' ? 'Live now' : props.game.status === 'final' ? 'Final' : 'Upcoming'} · ${props.game.period_label}`}
          status={props.game.status === 'live' ? 'Waiting for stream' : 'No video loaded yet'}
        />
      )}

      {/* 3. YouTube link as a dropdown UNDER the video — TEMPORARY until
          YouTube auto-starts on Go Live. Same attach logic, rehoused. */}
      {canRole(props.role, 'head_coach') && (
        <div className="youtube-dropdown">
          <button
            type="button"
            className="youtube-dropdown-toggle btn-icon"
            aria-expanded={youtubeOpen}
            onClick={() => setYoutubeOpen((o) => !o)}
          >
            <Icon name="video" />Add YouTube link {youtubeOpen ? '▴' : '▾'}
          </button>
          {youtubeOpen && (
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
              <button type="submit" className="btn-icon"><Icon name="check" />Save video</button>
            </form>
          )}
        </div>
      )}

      {/* Stat mode: checkbox BELOW the video screen. Unchecked =
          automatic (default): one stat tap updates score, box score,
          player totals, and derived stats. Checked = manual: stat taps
          record the play but do not move the score. */}
      <label className="manual-stats-toggle">
        <input
          type="checkbox"
          checked={manualMode}
          onChange={(e) => setManualMode(e.target.checked)}
        />
        Keep stats manually
      </label>
      {manualMode && (
        <p className="sub-hint">
          Manual mode — stat taps record the play without changing the score. Manage the score
          by hand with the score buttons below.
        </p>
      )}

      <h3>On court — tap a player, then tap a stat</h3>
      <div className={`cards ${statHint ? 'cards-need-player' : ''}`}>
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
                setStatHint(false);
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
        {canAssistant &&
          (!subMode ? (
            <button onClick={() => setSubMode(true)} className="btn-icon"><Icon name="sub" />Sub</button>
          ) : (
            <>
              <span className="sub-hint">Tap the player going out, then the bench player coming in.</span>
              <button disabled={!subOut || !subIn} onClick={confirmSub} className="btn-icon">
                <Icon name="check" />Confirm sub
              </button>
              <button onClick={exitSubMode} className="btn-icon"><Icon name="x" />Cancel</button>
            </>
          ))}
      </div>
      {subMode && (
        <p>
          Out: <strong>{subOutPlayer?.name ?? '—'}</strong> · In: <strong>{subInPlayer?.name ?? '—'}</strong>
        </p>
      )}

      {/* Stat buttons stay up whether or not a player is selected.
          Tapping one with no selection shows a hint + highlights the
          on-court cards instead of recording. Hidden in sub mode so
          the sub flow stays unambiguous. */}
      {!subMode && (
        <>
          {selected ? (
            <p>
              Tagging: <strong>{selected.name}</strong>
            </p>
          ) : (
            <p className="stat-hint" aria-live="polite">
              {statHint
                ? 'Select a player first — tap an on-court card, then tap a stat.'
                : 'Tap an on-court player, then tap a stat.'}
            </p>
          )}
          <div className="row">
            {statButtons.map((s) => (
              <button key={s.label} onClick={() => handleStatClick(s)} className="btn-icon">
                <Icon name={s.icon} />
                {s.label}
                {/* In manual mode stat taps do not move the score, so
                    the point labels would lie — hide them. */}
                {!manualMode && s.points > 0 && s.side === 'ours' ? ` (+${s.points})` : ''}
                {!manualMode && s.points > 0 && s.side === 'opponent' ? ' (opp +1)' : ''}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="row">
        {/* Manual mode: the coach manages the score by hand — Us +1
            alongside the existing Opponent scores button. In automatic
            mode the score follows stat taps, so Us +1 stays hidden. */}
        {manualMode && (
          <button onClick={props.onOurScores} className="btn-icon"><Icon name="plus" />Us scores (+1)</button>
        )}
        <button onClick={props.onOpponentScores} className="btn-icon"><Icon name="plus" />Opponent scores (+1)</button>
        <button onClick={props.onUndo} className="btn-icon"><Icon name="undo" />Undo last event</button>
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

      <h3>Box score</h3>
      {boxScore.length === 0 ? (
        <p>No events logged yet.</p>
      ) : (
        <>
          <table className="boxscore">
            <thead>
              <tr>
                <th>Player</th>
                <th>Points</th>
                {/* Derived auto-stats show in automatic mode only —
                    manual mode shows raw counts. */}
                {!manualMode && <th title="(Kills − Errors) / Attack Attempts">Hitting %</th>}
                <th>Stats</th>
              </tr>
            </thead>
            <tbody>
              {boxScore.map((row) => (
                <tr key={row.name}>
                  <td>{row.name}</td>
                  <td>{row.points}</td>
                  {!manualMode && (
                    <td>{row.hitting === null ? '—' : formatHittingPct(row.hitting)}</td>
                  )}
                  <td>{Object.entries(row.stats).map(([k, v]) => `${k}: ${v}`).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!manualMode && (
            <p className="sub-hint">Hitting % = (Kills − Errors) / Attack Attempts.</p>
          )}
        </>
      )}

    </section>
  );
}

function GameDetailScreen(props: {
  role: ClientRole;
  game: Game;
  teamName: string;
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
  onOpenReview: (gameId: string) => void;
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
      // Points only count for our side: a Serve Error / Passing Error is
      // recorded with side 'opponent' and its point belongs to the
      // opponent, not to the player who made the error.
      if (e.side === 'ours') entry.points += e.points;
      byPlayer.set(e.player_id, entry);
    }
    return [...byPlayer.values()];
  }, [props.events, props.players]);

  // CSV export via the shared builder (same CSV the Export Center
  // produces) — a real CSV built client-side from the same game data,
  // so export always works — with or without Google configured.
  function downloadCsv() {
    downloadGameCsv(props.game, props.players, props.events);
  }

  return (
    <section>
      <button onClick={props.onBack} className="btn-icon"><Icon name="back" />All games</button>{' '}
      <button onClick={props.onLive} className="btn-icon"><Icon name="live" />Live screen</button>
      <h2>
        Game detail — vs {props.game.opponent || 'TBD'} · Final {props.game.our_score}:{props.game.opponent_score}
      </h2>
      <p>
        Status: <strong>{props.game.status}</strong>
      </p>
      <div className="row">
        {canRole(props.role, 'assistant') && props.game.status === 'draft' && (
          <button onClick={() => props.onSetStatus('live')} className="btn-icon"><Icon name="goLive" />Go Live</button>
        )}
        {canRole(props.role, 'assistant') && props.game.status === 'live' && (
          <button onClick={() => props.onSetStatus('final')} className="btn-icon"><Icon name="endGame" />End Game</button>
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
      {canRole(props.role, 'head_coach') && (
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
          <button type="submit" className="btn-icon"><Icon name="check" />Save video</button>
        </form>
      )}
      {props.game.youtube_video_id ? (
        <YouTubePlayer videoId={props.game.youtube_video_id} isLive={props.game.status === 'live'} />
      ) : (
        <VideoPlaceholder
          title={`${props.teamName} vs ${props.game.opponent || 'TBD'}`}
          subtitle={`${props.game.status === 'live' ? 'Live now' : props.game.status === 'final' ? 'Final' : 'Upcoming'} · ${props.game.period_label}`}
          status={props.game.status === 'live' ? 'Waiting for stream' : 'No video loaded yet'}
        />
      )}

      <AiAnalysisSection game={props.game} role={props.role} onOpenReview={props.onOpenReview} />

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
              className="btn-icon"
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
              <Icon name="copy" />{copied ? 'Copied!' : 'Copy link'}
            </button>
          </div>
          {canRole(props.role, 'head_coach') && (
            <div className="row">
              <button onClick={props.onUnpublish} className="btn-icon"><Icon name="eyeOff" />Unpublish</button>
              <button onClick={props.onRevoke} className="btn-icon"><Icon name="refresh" />Regenerate link</button>
            </div>
          )}
          <p>
            <small>Regenerating the link kills the old one — anyone with the old link can no longer watch.</small>
          </p>
        </>
      ) : (
        <>
          <p>Not published — the watch link only works after you publish this game.</p>
          {canRole(props.role, 'head_coach') && (
            <button onClick={props.onPublish} className="btn-icon"><Icon name="eye" />Publish watch link</button>
          )}
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
        {canRole(props.role, 'head_coach') && (
          <button
            disabled={!props.game.published || smsBusy}
            className="btn-icon"
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
            <Icon name="send" />{smsBusy ? 'Sending…' : 'Notify families (highlights ready)'}
          </button>
        )}
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
      {canRole(props.role, 'head_coach') && (
        <>
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
        </>
      )}

      {canRole(props.role, 'head_coach') && (
        <>
          <h3>Export</h3>
          <p>
            Export this game&apos;s box score + timeline to a Google Sheet, or download the same data
            as a CSV — the CSV always works, with or without Google configured.
          </p>
          <div className="row">
            <button
              disabled={sheetBusy}
              className="btn-icon"
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
              <Icon name="export" />{sheetBusy ? 'Exporting…' : 'Export to Google Sheets'}
            </button>
            <button type="button" onClick={downloadCsv} className="btn-icon">
              <Icon name="download" />Download CSV
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
        </>
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
                      {canRole(props.role, 'assistant') && (
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
                      )}
                    </>
                  ) : (
                    canRole(props.role, 'assistant') && (
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
                    )
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
function PlayerProfileScreen(props: { role: ClientRole; player: Player | undefined; onBack: () => void }) {
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
      {canRole(props.role, 'head_coach') ? (
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
      ) : (
        <>
          {bio && (
            <p>{bio}</p>
          )}
          <ul>
            {height && <li>Height: {height}</li>}
            {graduationYear && <li>Graduation year: {graduationYear}</li>}
            {positionsText && <li>Positions: {positionsText}</li>}
            {school && <li>School: {school}</li>}
            {clubTeam && <li>Club team: {clubTeam}</li>}
          </ul>
          {!bio && !height && !graduationYear && !positionsText && !school && !clubTeam && (
            <p>No bio or measurables yet.</p>
          )}
        </>
      )}

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
              className="btn-icon"
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
              <Icon name="copy" />{enrollCopied ? 'Copied!' : 'Copy link'}
            </button>
          </div>
          <div className="row">
            {canRole(props.role, 'head_coach') && (
              <button
                className="btn-icon"
                onClick={() => run(async () => {
                  await api.generateEnrollToken(player.id);
                })}
              >
                <Icon name="refresh" />Regenerate link
              </button>
            )}
          </div>
          <p>
            <small>Regenerating the link kills the old one.</small>
          </p>
        </>
      ) : (
        <>
          <p>No enrollment link yet.</p>
          {canRole(props.role, 'head_coach') && (
            <button
              className="btn-icon"
              onClick={() => run(async () => {
                await api.generateEnrollToken(player.id);
              })}
            >
              <Icon name="plus" />Create enrollment link
            </button>
          )}
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
              {canRole(props.role, 'head_coach') && (
                <button
                  onClick={() => run(async () => {
                    await api.removeFamily(c.id);
                  })}
                >
                  Remove
                </button>
              )}
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
              className="btn-icon"
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
              <Icon name="copy" />{copied ? 'Copied!' : 'Copy link'}
            </button>
          </div>
          <div className="row">
            {canRole(props.role, 'head_coach') && (
              <>
                <button onClick={() => run(() => api.unpublishProfile(player.id))} className="btn-icon"><Icon name="eyeOff" />Unpublish</button>
                <button onClick={() => run(() => api.revokeProfileLink(player.id))} className="btn-icon"><Icon name="refresh" />Regenerate link</button>
              </>
            )}
          </div>
          <p>
            <small>Regenerating the link kills the old one — anyone with the old link can no longer view the profile.</small>
          </p>
        </>
      ) : (
        <>
          <p>Not published — the profile link only works after you publish it.</p>
          {canRole(props.role, 'head_coach') && (
            <button onClick={() => run(() => api.publishProfile(player.id))} className="btn-icon"><Icon name="eye" />Publish profile link</button>
          )}
        </>
      )}

      {canRole(props.role, 'head_coach') && <ParentsSection player={player} />}
    </section>
  );
}

/** Parents subsection (head_coach+, on the player profile): real
 *  parent LOGINS linked to this player (migration 012). A parent sees
 *  only their linked players — this player's profile/stats, the team's
 *  published games, and their own Drive imports. Create a parent
 *  account here (name/email/initial password — share the password
 *  out-of-band), link an existing parent account (a second kid, or
 *  the other parent), unlink, reset a password, or delete the account
 *  (blocked while the parent owns imported videos). */
function ParentsSection({ player }: { player: Player }) {
  type LinkedParent = Omit<ParentAccount, 'playerIds'>;
  const [parents, setParents] = useState<LinkedParent[]>([]);
  const [allParents, setAllParents] = useState<ParentAccount[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [linkPick, setLinkPick] = useState('');
  const [resetState, setResetState] = useState<Record<string, { next: string; confirm: string }>>({});

  const load = useCallback(async () => {
    try {
      const [linked, all] = await Promise.all([
        api.getPlayerParents(player.id),
        api.listParents(),
      ]);
      setParents(linked);
      setAllParents(all);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load parents.');
    }
  }, [player.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setError('');
    setMessage('');
    try {
      await action();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  }

  // Parents in the org that are NOT already linked to this player.
  const linkable = allParents.filter((p) => !parents.some((lp) => lp.id === p.id));

  return (
    <>
      <h3>Parents</h3>
      <p>
        Parent accounts are real logins. A parent sees only the players linked to them — this
        player&apos;s profile and stats, the team&apos;s published games, and their own imported
        videos. Share the initial password out-of-band; they can change it in their Account
        screen.
      </p>
      {error && <p className="error">{error}</p>}
      {message && <p>{message}</p>}
      {parents.length === 0 ? (
        <p>No parent accounts linked yet.</p>
      ) : (
        <ul className="list">
          {parents.map((p) => (
            <li key={p.id}>
              <strong>{p.name}</strong> — {p.email}{' '}
              <button
                onClick={() => {
                  if (!window.confirm(`Unlink ${p.name} from ${player.name}? They keep their account and any other linked players.`)) return;
                  void run(() => api.unlinkParent(p.id, player.id));
                }}
              >
                Unlink
              </button>{' '}
              <button
                onClick={() => {
                  if (!window.confirm(`Delete ${p.name}'s parent account (${p.email})? They will no longer be able to log in.`)) return;
                  void run(async () => {
                    await api.deleteParent(p.id);
                    setMessage(`Parent account deleted for ${p.name}.`);
                  });
                }}
              >
                Delete account
              </button>
              <div className="row">
                <input
                  type="password"
                  placeholder="New password (8+ characters)"
                  value={resetState[p.id]?.next ?? ''}
                  onChange={(e) =>
                    setResetState((prev) => ({
                      ...prev,
                      [p.id]: { next: e.target.value, confirm: prev[p.id]?.confirm ?? '' },
                    }))
                  }
                />
                <input
                  type="password"
                  placeholder="Confirm new password"
                  value={resetState[p.id]?.confirm ?? ''}
                  onChange={(e) =>
                    setResetState((prev) => ({
                      ...prev,
                      [p.id]: { next: prev[p.id]?.next ?? '', confirm: e.target.value },
                    }))
                  }
                />
                <button
                  onClick={() => {
                    const r = resetState[p.id];
                    if (!r) return;
                    if (r.next !== r.confirm) {
                      setError('New passwords do not match.');
                      return;
                    }
                    void run(async () => {
                      await api.resetParentPassword(p.id, r.next);
                      setResetState((prev) => {
                        const nextState = { ...prev };
                        delete nextState[p.id];
                        return nextState;
                      });
                      setMessage(
                        `Password reset for ${p.name}. Share the new password with them out-of-band — they will need to log in again.`,
                      );
                    });
                  }}
                >
                  Reset password
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h4>Add a parent account</h4>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api.createParent({ name, email, password, player_id: player.id });
            setName('');
            setEmail('');
            setPassword('');
            setMessage('Parent account created and linked to this player.');
          });
        }}
      >
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Parent name" required maxLength={100} />
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" required />
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Initial password (8+ characters)" required />
          <button type="submit">Create + link</button>
        </div>
      </form>

      {linkable.length > 0 && (
        <>
          <h4>Link an existing parent</h4>
          <div className="row">
            <select value={linkPick} onChange={(e) => setLinkPick(e.target.value)}>
              <option value="">Choose a parent…</option>
              {linkable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.email}
                </option>
              ))}
            </select>
            <button
              disabled={!linkPick}
              onClick={() => {
                void run(async () => {
                  await api.linkParent(linkPick, player.id);
                  setLinkPick('');
                  setMessage('Parent linked to this player.');
                });
              }}
            >
              Link to this player
            </button>
          </div>
        </>
      )}
    </>
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
          <div className="org-brand-row"><img className="org-logo" src="/icon.svg?v=3" alt="SimpliGame logo" /><h1>SimpliGame</h1></div>
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
    // Public face: this page wears the ORG's colors (from the payload),
    // not the SimpliGame shell palette — families see their club.
    <div
      className="page"
      style={{ ['--brand' as string]: profile.primary_color, ['--brand2' as string]: profile.secondary_color }}
    >
      <header className="org-header">
        <div className="org-brand-row"><img className="org-logo" src="/icon.svg?v=3" alt="SimpliGame logo" /><h1>SimpliGame</h1></div>
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
          <div className="org-brand-row"><img className="org-logo" src="/icon.svg?v=3" alt="SimpliGame logo" /><h1>SimpliGame</h1></div>
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
    // Public face: this page wears the ORG's colors (from the payload),
    // not the SimpliGame shell palette — families see their club.
    <div
      className="page"
      style={{ ['--brand' as string]: watch.primary_color, ['--brand2' as string]: watch.secondary_color }}
    >
      <header className="org-header">
        <div className="org-brand-row"><img className="org-logo" src="/icon.svg?v=3" alt="SimpliGame logo" /><h1>SimpliGame</h1></div>
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
  role: ClientRole;
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
      <h2>Reel library</h2>
      {error && <p className="error">{error}</p>}
      {canRole(props.role, 'head_coach') && (
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
      )}
      {reels.length === 0 ? (
        <p>
          No reels yet. Create one here, or use <strong>Auto Reel</strong> above
          to build a draft from a game&apos;s highlights.
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
                {canRole(props.role, 'head_coach') && (
                  <>
                    <button onClick={() => props.onOpen(r.id)}>Open in Studio</button>{' '}
                    <button onClick={() => handleDelete(r.id)}>Delete</button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Export Center — the central hub for ALL exports. Every game (across
 * the coach's teams) with Export to Google Sheets + Download CSV
 * actions, plus the Past Exports list (every Sheets export, newest
 * first). Reuses the existing export endpoints and the shared CSV
 * builder — the per-game Export section inside Game Detail stays
 * as-is as a convenience.
 */
function ExportCenterScreen(props: { workspace: Workspace }) {
  type PastExport = SheetExport & {
    opponent: string;
    status: string;
    our_score: number;
    opponent_score: number;
    team_name: string;
  };
  const [pastExports, setPastExports] = useState<PastExport[]>([]);
  const [pastError, setPastError] = useState('');
  const [busyGameId, setBusyGameId] = useState<string | null>(null);
  const [exportResults, setExportResults] = useState<Record<string, { sheetUrl?: string; error?: string }>>({});

  const loadPastExports = useCallback(() => {
    api
      .getAllSheetExports()
      .then(setPastExports)
      .catch((e) => setPastError(e instanceof Error ? e.message : 'Failed to load past exports'));
  }, []);

  useEffect(() => {
    loadPastExports();
  }, [loadPastExports]);

  async function handleExportSheets(gameId: string) {
    setBusyGameId(gameId);
    setExportResults((prev) => ({ ...prev, [gameId]: {} }));
    try {
      const result = await api.exportToSheets(gameId);
      if (result.notConfigured) {
        setExportResults((prev) => ({
          ...prev,
          [gameId]: { error: 'Google Sheets is not configured yet — set the Google OAuth env vars on the server, then try again. (The CSV download works right now.)' },
        }));
      } else if (result.sheetUrl) {
        setExportResults((prev) => ({ ...prev, [gameId]: { sheetUrl: result.sheetUrl } }));
        loadPastExports();
      } else {
        setExportResults((prev) => ({ ...prev, [gameId]: { error: 'Export did not return a Sheet link.' } }));
      }
    } catch (e) {
      setExportResults((prev) => ({
        ...prev,
        [gameId]: { error: e instanceof Error ? e.message : 'Export failed' },
      }));
    } finally {
      setBusyGameId(null);
    }
  }

  const games = props.workspace.games;
  const players = props.workspace.players;
  const events = props.workspace.events;

  return (
    <>
      <section>
        <h2 className="btn-icon"><Icon name="exports" size={22} />Export Center</h2>
        <p>
          Every game in one place — export any game to Google Sheets or download its CSV.
          Sheets exports are recorded below so you can reopen them anytime.
        </p>
      </section>

      <section>
        <h3>Games</h3>
        {games.length === 0 ? (
          <p>No games yet — create one from the Live tab.</p>
        ) : (
          <ul className="list">
            {games.map((g) => {
              const team = props.workspace.teams.find((t) => t.id === g.team_id);
              const result = exportResults[g.id];
              return (
                <li key={g.id}>
                  <strong>{team?.name ?? 'Team'} vs {g.opponent || 'TBD'}</strong> · {g.status} ·{' '}
                  {g.our_score}:{g.opponent_score} · {g.period_label}
                  <div className="row">
                    <button
                      type="button"
                      disabled={busyGameId === g.id}
                      className="btn-icon"
                      onClick={() => handleExportSheets(g.id)}
                    >
                      <Icon name="export" />{busyGameId === g.id ? 'Exporting…' : 'Export to Google Sheets'}
                    </button>
                    <button
                      type="button"
                      className="btn-icon"
                      onClick={() =>
                        downloadGameCsv(
                          g,
                          players.filter((p) => p.team_id === g.team_id),
                          events.filter((e) => e.game_id === g.id),
                        )
                      }
                    >
                      <Icon name="download" />Download CSV
                    </button>
                  </div>
                  {result?.sheetUrl && (
                    <p>
                      <a href={result.sheetUrl} target="_blank" rel="noreferrer">
                        Open Sheet
                      </a>
                    </p>
                  )}
                  {result?.error && <p className="error">{result.error}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h3>Past Exports</h3>
        {pastError && <p className="error">{pastError}</p>}
        {pastExports.length === 0 ? (
          <p>No Sheets exports yet.</p>
        ) : (
          <ul className="list">
            {pastExports.map((ex) => (
              <li key={ex.id}>
                <strong>{ex.team_name} vs {ex.opponent || 'TBD'}</strong> · {ex.status} ·{' '}
                {new Date(ex.created_at).toLocaleString()} ·{' '}
                <a href={ex.sheet_url} target="_blank" rel="noreferrer">
                  Open Sheet
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/**
 * Reel Studio tab with no reel selected: a picker of builds to open.
 * Opening one switches the Studio tab to that build's editor. New
 * builds are created from Highlight Builder (Auto Reel or Create reel).
 */
function StudioPickerScreen(props: {
  games: Game[];
  teams: Team[];
  onOpen: (reelId: string) => void;
}) {
  const [reels, setReels] = useState<ReelProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .listReels()
      .then(setReels)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load reels'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <section><p>Loading reels…</p></section>;

  return (
    <section>
      <h2>Reel Studio</h2>
      {error && <p className="error">{error}</p>}
      <p>Pick a build to edit manually, or create one from Highlight Builder.</p>
      {reels.length === 0 ? (
        <p>
          No builds yet — use <strong>Auto Reel</strong> on Highlight Builder to build a draft
          from a game&apos;s highlights, or create a reel from the library there.
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
                <button onClick={() => props.onOpen(r.id)}>Open in Studio</button>
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
function ReelStudioScreen(props: { role: ClientRole; reelId: string; workspace: Workspace; onBack: () => void }) {
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
    // Clips saved before imported videos existed lack the new fields —
    // normalize so every clip in state has the full shape.
    setClips(
      r.clips.map((c) => ({
        ...c,
        importedVideoId: typeof c.importedVideoId === 'string' ? c.importedVideoId : null,
        playerTag: typeof c.playerTag === 'string' ? c.playerTag : null,
      })),
    );
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
  if (!reel) return <section><button onClick={props.onBack}>← Highlight Builder</button><p className="error">{error || 'Reel not found.'}</p></section>;
  // Defense-in-depth: the studio is only reachable via UI for
  // head_coach+, but a lower role landing here gets a note, not the editor.
  if (!canRole(props.role, 'head_coach')) {
    return (
      <section>
        <button onClick={props.onBack}>← Highlight Builder</button>
        <p>Your role does not allow editing reels.</p>
      </section>
    );
  }

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
      <button onClick={props.onBack} className="btn-icon"><Icon name="back" />Highlight Builder</button>
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
          {previewClip?.importedVideoId ? (
            <ImportedVideoPlayer
              key={`imp-${previewIndex}`}
              videoId={previewClip.importedVideoId}
              startSeconds={previewClip.startSeconds}
              endSeconds={previewClip.endSeconds}
            />
          ) : previewClip?.videoId ? (
            <YouTubePlayer
              videoId={previewClip.videoId}
              isLive={false}
              startSeconds={previewClip.startSeconds}
            />
          ) : (
            <VideoPlaceholder
              title={reel?.name ?? 'Reel'}
              subtitle={`Clip ${previewIndex + 1} of ${clips.length}`}
              status="No clip video"
            />
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
                {clip.importedVideoId
                  ? `imported video${clip.playerTag ? ` · ${clip.playerTag}` : ''}`
                  : clip.videoId
                    ? 'video attached'
                    : 'no video'} · {formatTimestamp(clip.startSeconds)} →{' '}
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
                        importedVideoId: null,
                        playerTag: null,
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

      <AddImportedClipSection
        players={props.workspace.players}
        onAdd={(clip) => setClips((prev) => [...prev, clip])}
      />
    </section>
  );
}

/** Add a clip from an imported Drive video: pick the source, play it
 *  (real seek — Drive media URLs support Range), set in/out points,
 *  optionally tag a player (label only, for the overlay), and add it
 *  to the reel. Imported clips save alongside YouTube clips in the
 *  same reel — the preview handles both player types. */
function AddImportedClipSection(props: {
  players: Player[];
  onAdd: (clip: ReelClip) => void;
}) {
  const [videos, setVideos] = useState<ImportedVideo[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [inPoint, setInPoint] = useState(0);
  const [outPoint, setOutPoint] = useState(10);
  const [playerTag, setPlayerTag] = useState('');
  const [added, setAdded] = useState(false);
  const timeRef = useRef(0);

  useEffect(() => {
    api
      .listImportedVideos()
      .then((v) => setVideos(v.filter((x) => x.ready)))
      .catch(() => {
        // Import may not be set up yet — the section just stays empty.
      });
  }, []);

  const selected = videos.find((v) => v.id === selectedId);

  return (
    <>
      <h3>Add from imported video</h3>
      {videos.length === 0 ? (
        <p>
          No imported videos yet — import game film in Highlight Builder (it lives in the
          uploader&apos;s own Google Drive).
        </p>
      ) : (
        <>
          <div className="row">
            <select
              value={selectedId}
              onChange={(e) => {
                setSelectedId(e.target.value);
                setInPoint(0);
                setOutPoint(10);
                setAdded(false);
              }}
            >
              <option value="">Pick an imported video…</option>
              {videos.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.title}
                </option>
              ))}
            </select>
          </div>
          {selected && (
            <>
              <ImportedVideoPlayer
                key={selected.id}
                videoId={selected.id}
                onTimeUpdate={(t) => {
                  timeRef.current = t;
                }}
              />
              <div className="row">
                <button
                  onClick={() => setInPoint(Math.max(0, Math.floor(timeRef.current)))}
                >
                  Set in ({formatTimestamp(inPoint)})
                </button>
                <button onClick={() => setOutPoint(Math.max(inPoint + 1, Math.ceil(timeRef.current)))}>
                  Set out ({formatTimestamp(outPoint)})
                </button>
                <label className="field-label">
                  Player tag (optional)
                  <select value={playerTag} onChange={(e) => setPlayerTag(e.target.value)}>
                    <option value="">No player tag</option>
                    {props.players.map((p) => {
                      const tag = `#${p.jersey_number} ${p.name}`;
                      return (
                        <option key={p.id} value={tag}>
                          {tag}
                        </option>
                      );
                    })}
                  </select>
                </label>
                <button
                  disabled={outPoint <= inPoint}
                  onClick={() => {
                    props.onAdd({
                      eventId: null,
                      gameId: null,
                      videoId: null,
                      importedVideoId: selected.id,
                      playerTag: playerTag || null,
                      startSeconds: inPoint,
                      endSeconds: outPoint,
                      transition: 'cut',
                      overlay: playerTag ? `${playerTag} — ${selected.title}` : selected.title,
                      slowMo: false,
                    });
                    setAdded(true);
                  }}
                >
                  Add clip to reel
                </button>
              </div>
              {added && <p>Clip added — remember to Save reel.</p>}
              <p>
                <small>
                  Play the video, pause at the moment, then Set in / Set out. The player tag is a
                  label for the overlay only — it does not change any stats.
                </small>
              </p>
            </>
          )}
        </>
      )}
    </>
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
          <div className="org-brand-row"><img className="org-logo" src="/icon.svg?v=3" alt="SimpliGame logo" /><h1>SimpliGame</h1></div>
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
          <div className="org-brand-row"><img className="org-logo" src="/icon.svg?v=3" alt="SimpliGame logo" /><h1>SimpliGame</h1></div>
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
        <div className="org-brand-row"><img className="org-logo" src="/icon.svg?v=3" alt="SimpliGame logo" /><h1>SimpliGame</h1></div>
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
