import express from 'express';
import path from 'path';
import { getOrCreateOrganization, getPool } from './db';
import { extractYouTubeVideoId } from './youtube';

const app = express();
app.use(express.json());

/**
 * Small async wrapper: any unexpected error inside a handler becomes a
 * 500 with a safe message. Input-validation failures are returned by the
 * handlers themselves as 400s *before* any database work, so a bad
 * YouTube link can never surface as a 500.
 */
function asyncHandler(
  fn: (req: express.Request, res: express.Response) => Promise<void>,
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    fn(req, res).catch((err) => {
      console.error('API error:', err);
      res.status(500).json({ ok: false, error: 'Something went wrong on the server.' });
    });
  };
}

// ---------------------------------------------------------------- health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ------------------------------------------------------------- workspace
// Full state in one call: org, teams, players, games, events, lineups.
app.get(
  '/api/workspace',
  asyncHandler(async (_req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization();
    const [teams, players, games, events, lineups] = await Promise.all([
      db.query('SELECT * FROM teams WHERE org_id = $1 ORDER BY created_at ASC', [org.id]),
      db.query(
        `SELECT p.* FROM players p JOIN teams t ON t.id = p.team_id
         WHERE t.org_id = $1 ORDER BY p.created_at ASC`,
        [org.id],
      ),
      db.query(
        `SELECT g.* FROM games g JOIN teams t ON t.id = g.team_id
         WHERE t.org_id = $1 ORDER BY g.created_at ASC`,
        [org.id],
      ),
      db.query(
        `SELECT e.* FROM game_events e JOIN games g ON g.id = e.game_id
         JOIN teams t ON t.id = g.team_id
         WHERE t.org_id = $1 ORDER BY e.created_at ASC`,
        [org.id],
      ),
      db.query(
        `SELECT l.* FROM lineups l JOIN games g ON g.id = l.game_id
         JOIN teams t ON t.id = g.team_id
         WHERE t.org_id = $1 ORDER BY l.slot ASC`,
        [org.id],
      ),
    ]);
    res.json({
      ok: true,
      organization: org,
      teams: teams.rows,
      players: players.rows,
      games: games.rows,
      events: events.rows,
      lineups: lineups.rows,
    });
  }),
);

// ----------------------------------------------------------------- teams
app.post(
  '/api/teams',
  asyncHandler(async (req, res) => {
    const { name, sport, season } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ ok: false, error: 'Team name is required.' });
      return;
    }
    const db = getPool();
    const org = await getOrCreateOrganization();
    const result = await db.query(
      `INSERT INTO teams (org_id, name, sport, season)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [org.id, name.trim(), typeof sport === 'string' ? sport : 'Volleyball', typeof season === 'string' ? season : ''],
    );
    res.status(201).json({ ok: true, team: result.rows[0] });
  }),
);

// --------------------------------------------------------------- players
app.get(
  '/api/teams/:teamId/players',
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization();
    const result = await db.query(
      `SELECT p.* FROM players p JOIN teams t ON t.id = p.team_id
       WHERE t.org_id = $1 AND p.team_id = $2 ORDER BY p.created_at ASC`,
      [org.id, req.params.teamId],
    );
    res.json({ ok: true, players: result.rows });
  }),
);

app.post(
  '/api/teams/:teamId/players',
  asyncHandler(async (req, res) => {
    const { name, jersey_number, position } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ ok: false, error: 'Player name is required.' });
      return;
    }
    const db = getPool();
    const org = await getOrCreateOrganization();
    // Confirm the team belongs to this org before inserting.
    const team = await db.query('SELECT id FROM teams WHERE id = $1 AND org_id = $2', [
      req.params.teamId,
      org.id,
    ]);
    if (team.rows.length === 0) {
      res.status(404).json({ ok: false, error: 'Team not found.' });
      return;
    }
    const result = await db.query(
      `INSERT INTO players (team_id, name, jersey_number, position)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [
        req.params.teamId,
        name.trim(),
        typeof jersey_number === 'string' ? jersey_number : '',
        typeof position === 'string' ? position : '',
      ],
    );
    res.status(201).json({ ok: true, player: result.rows[0] });
  }),
);

// ----------------------------------------------------------------- games
app.post(
  '/api/games',
  asyncHandler(async (req, res) => {
    const { team_id, opponent, sport, mode } = req.body ?? {};
    if (typeof team_id !== 'string' || !team_id) {
      res.status(400).json({ ok: false, error: 'team_id is required.' });
      return;
    }
    if (mode !== undefined && mode !== 'live' && mode !== 'film') {
      res.status(400).json({ ok: false, error: "mode must be 'live' or 'film'." });
      return;
    }
    const db = getPool();
    const org = await getOrCreateOrganization();
    const team = await db.query('SELECT id FROM teams WHERE id = $1 AND org_id = $2', [team_id, org.id]);
    if (team.rows.length === 0) {
      res.status(404).json({ ok: false, error: 'Team not found.' });
      return;
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const game = await client.query(
        `INSERT INTO games (team_id, opponent, sport, mode, status)
         VALUES ($1, $2, $3, $4, 'draft') RETURNING *`,
        [
          team_id,
          typeof opponent === 'string' ? opponent : '',
          typeof sport === 'string' ? sport : 'Volleyball',
          mode ?? 'live',
        ],
      );
      // Seed the starting lineup from the first 6 roster players so the
      // live screen has on-court cards immediately. Coaches reorder via
      // subs later (lineup editing is a follow-up).
      const roster = await client.query(
        'SELECT id FROM players WHERE team_id = $1 ORDER BY created_at ASC LIMIT 6',
        [team_id],
      );
      for (let i = 0; i < roster.rows.length; i++) {
        await client.query(
          'INSERT INTO lineups (game_id, player_id, slot) VALUES ($1, $2, $3)',
          [game.rows[0].id, roster.rows[i].id, i],
        );
      }
      await client.query('COMMIT');
      res.status(201).json({ ok: true, game: game.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);

app.get(
  '/api/games/:gameId',
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization();
    const game = await db.query(
      `SELECT g.* FROM games g JOIN teams t ON t.id = g.team_id
       WHERE t.org_id = $1 AND g.id = $2`,
      [org.id, req.params.gameId],
    );
    if (game.rows.length === 0) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    const [events, lineups] = await Promise.all([
      db.query('SELECT * FROM game_events WHERE game_id = $1 ORDER BY created_at ASC', [req.params.gameId]),
      db.query('SELECT * FROM lineups WHERE game_id = $1 ORDER BY slot ASC', [req.params.gameId]),
    ]);
    res.json({ ok: true, game: game.rows[0], events: events.rows, lineups: lineups.rows });
  }),
);

// ------------------------------------------------------------ stat events
// The core loop: tap a player, tap a stat, the event lands with a score
// update in the same transaction so the two can never drift apart.
app.post(
  '/api/games/:gameId/events',
  asyncHandler(async (req, res) => {
    const { player_id, stat_type, side, points, video_seconds } = req.body ?? {};
    if (typeof stat_type !== 'string' || !stat_type.trim()) {
      res.status(400).json({ ok: false, error: 'stat_type is required.' });
      return;
    }
    if (side !== undefined && side !== 'ours' && side !== 'opponent') {
      res.status(400).json({ ok: false, error: "side must be 'ours' or 'opponent'." });
      return;
    }
    const pts = Number(points ?? 0);
    if (!Number.isInteger(pts) || pts < 0) {
      res.status(400).json({ ok: false, error: 'points must be a non-negative integer.' });
      return;
    }
    const db = getPool();
    const org = await getOrCreateOrganization();
    const game = await db.query(
      `SELECT g.* FROM games g JOIN teams t ON t.id = g.team_id
       WHERE t.org_id = $1 AND g.id = $2`,
      [org.id, req.params.gameId],
    );
    if (game.rows.length === 0) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const event = await client.query(
        `INSERT INTO game_events (game_id, player_id, stat_type, side, points, video_seconds, entry_method)
         VALUES ($1, $2, $3, $4, $5, $6, 'live') RETURNING *`,
        [
          req.params.gameId,
          typeof player_id === 'string' ? player_id : null,
          stat_type.trim(),
          side ?? 'ours',
          pts,
          Number.isInteger(Number(video_seconds)) ? Number(video_seconds) : 0,
        ],
      );
      // Keep the running score in lockstep with the event log.
      if (pts > 0) {
        const column = (side ?? 'ours') === 'ours' ? 'our_score' : 'opponent_score';
        await client.query(`UPDATE games SET ${column} = ${column} + $1 WHERE id = $2`, [pts, req.params.gameId]);
      }
      await client.query('COMMIT');
      res.status(201).json({ ok: true, event: event.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);

// Undo: remove the game's most recent event and reverse its score effect.
app.post(
  '/api/games/:gameId/undo',
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization();
    const game = await db.query(
      `SELECT g.* FROM games g JOIN teams t ON t.id = g.team_id
       WHERE t.org_id = $1 AND g.id = $2`,
      [org.id, req.params.gameId],
    );
    if (game.rows.length === 0) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const last = await client.query(
        `SELECT * FROM game_events WHERE game_id = $1
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [req.params.gameId],
      );
      if (last.rows.length === 0) {
        await client.query('ROLLBACK');
        res.json({ ok: true, undone: null });
        return;
      }
      const event = last.rows[0];
      await client.query('DELETE FROM game_events WHERE id = $1', [event.id]);
      if (event.points > 0) {
        const column = event.side === 'ours' ? 'our_score' : 'opponent_score';
        await client.query(`UPDATE games SET ${column} = GREATEST(${column} - $1, 0) WHERE id = $2`, [
          event.points,
          req.params.gameId,
        ]);
      }
      await client.query('COMMIT');
      res.json({ ok: true, undone: event });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);

// --------------------------------------------------------------- YouTube
// Attach a YouTube recording/live stream to a game. Accepts any YouTube
// URL shape or a bare video ID; garbage input gets a 400 with a clear
// message — never a 500.
app.post(
  '/api/games/:gameId/youtube',
  asyncHandler(async (req, res) => {
    const { url } = req.body ?? {};
    const videoId = extractYouTubeVideoId(url);
    if (!videoId) {
      res.status(400).json({
        ok: false,
        error:
          'That does not look like a YouTube link or video ID. Paste a YouTube watch link, a youtu.be link, a live link, an embed link, or the 11-character video ID.',
      });
      return;
    }
    const db = getPool();
    const org = await getOrCreateOrganization();
    const result = await db.query(
      `UPDATE games g SET youtube_video_id = $1 FROM teams t
       WHERE g.team_id = t.id AND t.org_id = $2 AND g.id = $3
       RETURNING g.*`,
      [videoId, org.id, req.params.gameId],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    res.json({ ok: true, game: result.rows[0] });
  }),
);

// ------------------------------------------- static client (production)
// In production the client build (client/dist) is served by this server,
// so one Render web service hosts the whole app.
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
  app.use(express.static(clientDist));
  app.get('/*splat', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`SimpliGame server listening on port ${port}`);
});
