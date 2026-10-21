import crypto from 'crypto';
import express from 'express';
import path from 'path';
import {
  authenticate,
  authOf,
  can,
  canAccessTeam,
  cleanEmail,
  cleanName,
  cleanPassword,
  cleanTeamIds,
  clearSessionCookie,
  dummyPasswordCheck,
  hashPassword,
  hashSessionToken,
  isMissingTable,
  newSessionToken,
  NON_OWNER_ROLES,
  publicUser,
  requireAuth,
  requirePermission,
  sessionCookieValue,
  verifyPassword,
  type NonOwnerRole,
} from './auth';
import { getOrCreateOrganization, getPool } from './db';
import {
  applyReview,
  deriveOverallStatus,
  generateOverview,
  isAnalysisSectionKey,
  type StoredSectionReview,
} from './analysis';
import { exportGameToSheets, isSheetsConfigured, type SheetRows } from './sheets';
import {
  DRIVE_FILE_SCOPE,
  deleteDriveFile,
  exchangeCodeForTokens,
  findDriveFileInFolder,
  findOrCreateSimpliGameFolder,
  getDriveFile,
  getGoogleUserEmail,
  googleRedirectUri,
  initiateResumableUpload,
  isDriveConfigured,
  refreshDriveAccessToken,
} from './drive';
import { sendSms } from './sms';
import { extractYouTubeVideoId } from './youtube';

const app = express();
app.use(express.json());

// Auth: `authenticate` runs on every /api route and attaches req.auth
// when the request carries a valid session cookie. The gate below then
// enforces login for everything except the public routes — public watch
// / profile / enroll pages, the health check, and the auth endpoints
// themselves (which handle their own auth).
app.use('/api', authenticate);
// Worker routes (the local Dell worker) authenticate with the
// X-Worker-Key header, NOT a session cookie — the worker runs outside
// a browser and has no cookie. The handlers themselves verify the key;
// the gate here only exempts them from the session requirement.
function isWorkerRoute(method: string, path: string): boolean {
  if (method === 'GET' && path === '/analysis/jobs/pending') return true;
  if (method === 'POST' && /^\/analysis\/jobs\/[^/]+\/results$/.test(path)) return true;
  return false;
}
app.use('/api', (req, res, next) => {
  const path = req.path;
  if (
    path === '/health' ||
    path.startsWith('/public/') ||
    path.startsWith('/auth/') ||
    isWorkerRoute(req.method, path)
  ) {
    next();
    return;
  }
  requireAuth(req, res, next);
});

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

// ------------------------------------------------------------------ auth
// Coach logins. Sessions are opaque tokens in an HttpOnly cookie; the
// token itself is never stored, only its SHA-256 hash.
// Setup is a one-time bootstrap: it works ONLY when zero users exist,
// creates the owner for the existing (or default) organization, and
// refuses once the first user exists — so the owner can never be
// locked out and setup can never be re-run to hijack the org. The
// owner sets their own password here — never in chat, never hardcoded.
const AUTH_MIGRATION_MESSAGE =
  'Coach logins are not set up yet — run migrations/009_coach_auth.sql in the Neon SQL Editor, then restart.';

app.get(
  '/api/auth/status',
  asyncHandler(async (_req, res) => {
    const db = getPool();
    try {
      const count = await db.query('SELECT COUNT(*)::int AS n FROM users');
      res.json({ ok: true, usersExist: count.rows[0].n > 0 });
    } catch (err) {
      if (isMissingTable(err)) {
        res.json({ ok: true, usersExist: false, authUnavailable: true });
        return;
      }
      throw err;
    }
  }),
);

app.post(
  '/api/auth/setup',
  asyncHandler(async (req, res) => {
    const { email, password, name } = req.body ?? {};
    const cleanMail = cleanEmail(email);
    const cleanPass = cleanPassword(password);
    const cleanFullName = cleanName(name);
    if (!cleanMail) {
      res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
      return;
    }
    if (!cleanPass) {
      res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
      return;
    }
    if (!cleanFullName) {
      res.status(400).json({ ok: false, error: 'Name is required (100 characters or fewer).' });
      return;
    }
    const db = getPool();
    try {
      const existing = await db.query('SELECT COUNT(*)::int AS n FROM users');
      if (existing.rows[0].n > 0) {
        res.status(400).json({ ok: false, error: 'Setup has already been completed — log in instead.' });
        return;
      }
      const org = await getOrCreateOrganization();
      const user = await db.query(
        `INSERT INTO users (org_id, email, password_hash, name, role)
         VALUES ($1, $2, $3, $4, 'owner')
         RETURNING id, org_id, email, name, role, created_at`,
        [org.id, cleanMail, hashPassword(cleanPass), cleanFullName],
      );
      const token = newSessionToken();
      await db.query(
        `INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '30 days')`,
        [user.rows[0].id, hashSessionToken(token)],
      );
      res
        .status(201)
        .setHeader('Set-Cookie', sessionCookieValue(token))
        .json({ ok: true, user: publicUser(user.rows[0]) });
    } catch (err) {
      if (isMissingTable(err)) {
        res.status(503).json({ ok: false, error: AUTH_MIGRATION_MESSAGE });
        return;
      }
      if ((err as { code?: string }).code === '23505') {
        res.status(400).json({ ok: false, error: 'That email is already registered.' });
        return;
      }
      throw err;
    }
  }),
);

app.post(
  '/api/auth/login',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body ?? {};
    const cleanMail = cleanEmail(email);
    const db = getPool();
    try {
      const row = cleanMail
        ? await db.query('SELECT * FROM users WHERE email = $1 ORDER BY created_at ASC LIMIT 1', [cleanMail])
        : { rows: [] as never[] };
      const user = row.rows[0];
      const passwordOk =
        user && typeof password === 'string' ? verifyPassword(password, user.password_hash as string) : false;
      if (!user) {
        // Same scrypt cost as a real check, so timing doesn't reveal
        // whether the email exists.
        dummyPasswordCheck(typeof password === 'string' ? password : '');
      }
      if (!user || !passwordOk) {
        res.status(401).json({ ok: false, error: 'Invalid email or password.' });
        return;
      }
      const token = newSessionToken();
      await db.query(
        `INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '30 days')`,
        [user.id, hashSessionToken(token)],
      );
      res
        .setHeader('Set-Cookie', sessionCookieValue(token))
        .json({ ok: true, user: publicUser(user) });
    } catch (err) {
      if (isMissingTable(err)) {
        res.status(503).json({ ok: false, error: AUTH_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

app.post(
  '/api/auth/logout',
  asyncHandler(async (req, res) => {
    const db = getPool();
    try {
      // The cookie value is the raw token; the DB stores only its hash.
      const cookie = req.headers.cookie ?? '';
      const match = cookie.match(/(?:^|;\s*)sg_session=([^;]+)/);
      if (match) {
        await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashSessionToken(match[1])]);
      }
    } catch (err) {
      if (!isMissingTable(err)) throw err;
    }
    res.setHeader('Set-Cookie', clearSessionCookie()).json({ ok: true, loggedOut: true });
  }),
);

app.get(
  '/api/auth/me',
  asyncHandler(async (req, res) => {
    if (req.authUnavailable) {
      res.status(503).json({ ok: false, error: AUTH_MIGRATION_MESSAGE });
      return;
    }
    if (!req.auth) {
      res.status(401).json({ ok: false, error: 'Not logged in.' });
      return;
    }
    res.json({ ok: true, user: publicUser(req.auth.user), teamIds: req.auth.teamIds });
  }),
);

// Self-service profile update: any logged-in user edits ONLY their own
// name/email (never anyone else's — the WHERE clause is their own id).
// The email must stay unique within the org: the users table carries
// UNIQUE (org_id, email), and we check first so the user gets a clear
// error instead of a database failure. The session is untouched —
// changing your info never signs you out.
app.patch(
  '/api/auth/me',
  asyncHandler(async (req, res) => {
    if (req.authUnavailable) {
      res.status(503).json({ ok: false, error: AUTH_MIGRATION_MESSAGE });
      return;
    }
    if (!req.auth) {
      res.status(401).json({ ok: false, error: 'Not logged in.' });
      return;
    }
    const { name, email } = req.body ?? {};
    const cleanFullName = cleanName(name);
    const cleanMail = cleanEmail(email);
    if (!cleanFullName) {
      res.status(400).json({ ok: false, error: 'Name is required (100 characters or fewer).' });
      return;
    }
    if (!cleanMail) {
      res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
      return;
    }
    const db = getPool();
    try {
      const dupe = await db.query(
        'SELECT id FROM users WHERE org_id = $1 AND email = $2 AND id <> $3 LIMIT 1',
        [req.auth.user.org_id, cleanMail, req.auth.user.id],
      );
      if (dupe.rows.length > 0) {
        res.status(400).json({
          ok: false,
          error: 'That email is already used by another account in your organization.',
        });
        return;
      }
      const updated = await db.query(
        `UPDATE users SET name = $1, email = $2 WHERE id = $3
         RETURNING id, org_id, email, name, role, created_at`,
        [cleanFullName, cleanMail, req.auth.user.id],
      );
      res.json({ ok: true, user: publicUser(updated.rows[0]) });
    } catch (err) {
      if (isMissingTable(err)) {
        res.status(503).json({ ok: false, error: AUTH_MIGRATION_MESSAGE });
        return;
      }
      if ((err as { code?: string }).code === '23505') {
        res.status(400).json({
          ok: false,
          error: 'That email is already used by another account in your organization.',
        });
        return;
      }
      throw err;
    }
  }),
);

// Self-service change-password: any logged-in user. Verifies the
// current password, sets the new hash, and invalidates all of the
// user's OTHER sessions (the current session stays alive).
app.post(
  '/api/auth/change-password',
  asyncHandler(async (req, res) => {
    if (req.authUnavailable) {
      res.status(503).json({ ok: false, error: AUTH_MIGRATION_MESSAGE });
      return;
    }
    if (!req.auth) {
      res.status(401).json({ ok: false, error: 'Not logged in.' });
      return;
    }
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
      res.status(400).json({ ok: false, error: 'Current password is required.' });
      return;
    }
    const cleanNew = cleanPassword(newPassword);
    if (!cleanNew) {
      res.status(400).json({ ok: false, error: 'New password must be at least 8 characters.' });
      return;
    }
    const db = getPool();
    try {
      const row = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.auth.user.id]);
      if (row.rows.length === 0 || !verifyPassword(currentPassword, row.rows[0].password_hash as string)) {
        res.status(401).json({ ok: false, error: 'Current password is incorrect.' });
        return;
      }
      // Keep the current session alive; invalidate every other session.
      const cookie = req.headers.cookie ?? '';
      const match = cookie.match(/(?:^|;\s*)sg_session=([^;]+)/);
      const currentHash = match ? hashSessionToken(match[1]) : null;
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
          hashPassword(cleanNew),
          req.auth.user.id,
        ]);
        if (currentHash) {
          await client.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [
            req.auth.user.id,
            currentHash,
          ]);
        } else {
          await client.query('DELETE FROM sessions WHERE user_id = $1', [req.auth.user.id]);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      res.json({ ok: true, changed: true });
    } catch (err) {
      if (isMissingTable(err)) {
        res.status(503).json({ ok: false, error: AUTH_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

// ------------------------------------------- per-user Google Drive
// Video import storage: each coach connects THEIR OWN Google Drive
// (drive.file scope only — see drive.ts). The refresh token lives on
// the user row (migration 011); it is never returned by any response
// and never logged.
//
// These routes live under /api/auth/, which the session gate exempts —
// so each handler checks req.auth itself. /connect and /callback are
// browser navigations and answer with redirects back into the app
// (the SPA reads the ?google= flag and lands on the Account screen).
const DRIVE_MIGRATION_MESSAGE =
  'Google Drive import is not set up yet — run migrations/011_drive_import.sql in the Neon SQL Editor, then restart.';

/** Missing table (42P01) or missing column (42703) — migration 011 not run. */
function isMissingDriveSchema(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === '42P01' || code === '42703';
}

// OAuth `state`: HMAC-signed { uid, exp } so the callback can trust it
// without a server-side store. The client secret is the signing key
// (server-side only). The callback ALSO requires a live session for
// the same user — state alone never authorizes anything.
function signGoogleState(userId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ uid: userId, exp: Date.now() + 10 * 60 * 1000 }),
  ).toString('base64url');
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '';
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyGoogleState(state: string): string | null {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '';
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      uid?: string;
      exp?: number;
    };
    if (typeof parsed.uid !== 'string' || !parsed.uid) return null;
    if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return null;
    return parsed.uid;
  } catch {
    return null;
  }
}

app.get('/api/auth/google/connect', (req, res) => {
  if (!req.auth) {
    res.redirect('/?google=login-required');
    return;
  }
  if (!isDriveConfigured()) {
    res.redirect('/?google=not-configured');
    return;
  }
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID ?? '',
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    // drive.file: the app can only see/touch files it created in the
    // coach's Drive. `email` is the basic identity scope so the
    // Account screen can show "Connected as …".
    scope: `${DRIVE_FILE_SCOPE} email`,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: signGoogleState(req.auth.user.id),
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get(
  '/api/auth/google/callback',
  asyncHandler(async (req, res) => {
    const fail = (flag: string) => res.redirect(`/?google=${flag}`);
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (typeof req.query.error === 'string' || !code) {
      fail('denied');
      return;
    }
    const stateUserId = state ? verifyGoogleState(state) : null;
    if (!stateUserId) {
      fail('failed');
      return;
    }
    // The consent must come back to the same signed-in user who started
    // it — a session for a different (or no) user never stores a token.
    if (!req.auth || req.auth.user.id !== stateUserId) {
      fail('session');
      return;
    }
    if (!isDriveConfigured()) {
      fail('not-configured');
      return;
    }
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens) {
      fail('failed');
      return;
    }
    if (!tokens.refreshToken) {
      // prompt=consent makes Google return a refresh token; without one
      // there is nothing durable to store.
      fail('failed');
      return;
    }
    const email = await getGoogleUserEmail(tokens.accessToken);
    const db = getPool();
    try {
      await db.query('UPDATE users SET google_refresh_token = $1, google_email = $2 WHERE id = $3', [
        tokens.refreshToken,
        email,
        stateUserId,
      ]);
    } catch (err) {
      if (isMissingDriveSchema(err)) {
        fail('setup');
        return;
      }
      throw err;
    }
    res.redirect('/?google=connected');
  }),
);

app.get(
  '/api/auth/google/status',
  asyncHandler(async (req, res) => {
    if (!req.auth) {
      res.status(401).json({ ok: false, error: 'Please log in.' });
      return;
    }
    const db = getPool();
    try {
      const row = await db.query(
        'SELECT google_email, google_refresh_token IS NOT NULL AS connected FROM users WHERE id = $1',
        [req.auth.user.id],
      );
      const user = row.rows[0];
      res.json({
        ok: true,
        connected: Boolean(user?.connected),
        email: (user?.google_email as string | null) ?? null,
      });
    } catch (err) {
      if (isMissingDriveSchema(err)) {
        // Migration 011 not run yet — report "not connected" plus the
        // setup flag instead of an error, so the UI can say why.
        res.json({ ok: true, connected: false, email: null, setupRequired: true });
        return;
      }
      throw err;
    }
  }),
);

app.post(
  '/api/auth/google/disconnect',
  asyncHandler(async (req, res) => {
    if (!req.auth) {
      res.status(401).json({ ok: false, error: 'Please log in.' });
      return;
    }
    const db = getPool();
    try {
      await db.query('UPDATE users SET google_refresh_token = NULL, google_email = NULL WHERE id = $1', [
        req.auth.user.id,
      ]);
      res.json({ ok: true, connected: false });
    } catch (err) {
      if (isMissingDriveSchema(err)) {
        res.status(503).json({ ok: false, error: DRIVE_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

// --------------------------------------------------------------- coaches
// Owner-only coach management. Responses never include password_hash.
// Coaches get a role + team assignments; they see only their teams.
async function loadCoaches(db: ReturnType<typeof getPool>, orgId: string) {
  // Parent accounts (migration 012) are NOT coaches — they are managed
  // from the player profile's Parents section, never listed here.
  const users = await db.query(
    "SELECT id, org_id, email, name, role, created_at FROM users WHERE org_id = $1 AND role <> 'parent' ORDER BY created_at ASC",
    [orgId],
  );
  const userIds = users.rows.map((u) => u.id as string);
  const assigns =
    userIds.length > 0
      ? await db.query('SELECT user_id, team_id FROM coach_teams WHERE user_id = ANY($1)', [userIds])
      : { rows: [] as { user_id: string; team_id: string }[] };
  const teamIdsByUser = new Map<string, string[]>();
  for (const a of assigns.rows) {
    const list = teamIdsByUser.get(a.user_id) ?? [];
    list.push(a.team_id);
    teamIdsByUser.set(a.user_id, list);
  }
  return users.rows.map((u) => ({ ...publicUser(u), teamIds: teamIdsByUser.get(u.id) ?? [] }));
}

app.get(
  '/api/coaches',
  requirePermission('coach_manage'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    res.json({ ok: true, coaches: await loadCoaches(db, org.id) });
  }),
);

app.post(
  '/api/coaches',
  requirePermission('coach_manage'),
  asyncHandler(async (req, res) => {
    const { email, password, name, role, teamIds } = req.body ?? {};
    const cleanMail = cleanEmail(email);
    const cleanPass = cleanPassword(password);
    const cleanFullName = cleanName(name);
    const cleanTeams = cleanTeamIds(teamIds);
    if (!cleanMail) {
      res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
      return;
    }
    if (!cleanPass) {
      res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
      return;
    }
    if (!cleanFullName) {
      res.status(400).json({ ok: false, error: 'Name is required (100 characters or fewer).' });
      return;
    }
    if (!NON_OWNER_ROLES.includes(role as NonOwnerRole)) {
      res.status(400).json({ ok: false, error: "Role must be 'head_coach', 'assistant', or 'stat_crew'." });
      return;
    }
    if (!cleanTeams) {
      res.status(400).json({ ok: false, error: 'teamIds must be an array of team IDs.' });
      return;
    }
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    // Every assigned team must belong to this org.
    if (cleanTeams.length > 0) {
      const teams = await db.query('SELECT id FROM teams WHERE org_id = $1 AND id = ANY($2)', [
        org.id,
        cleanTeams,
      ]);
      if (teams.rows.length !== cleanTeams.length) {
        res.status(400).json({ ok: false, error: 'One or more selected teams were not found.' });
        return;
      }
    }
    try {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const user = await client.query(
          `INSERT INTO users (org_id, email, password_hash, name, role)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, org_id, email, name, role, created_at`,
          [org.id, cleanMail, hashPassword(cleanPass), cleanFullName, role],
        );
        for (const teamId of cleanTeams) {
          await client.query('INSERT INTO coach_teams (user_id, team_id) VALUES ($1, $2)', [
            user.rows[0].id,
            teamId,
          ]);
        }
        await client.query('COMMIT');
        const coaches = await loadCoaches(db, org.id);
        res.status(201).json({ ok: true, coach: coaches.find((c) => c.id === user.rows[0].id) });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        res.status(400).json({ ok: false, error: 'That email is already registered.' });
        return;
      }
      throw err;
    }
  }),
);

app.patch(
  '/api/coaches/:id',
  requirePermission('coach_manage'),
  asyncHandler(async (req, res) => {
    const { name, role, teamIds } = req.body ?? {};
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const targetId = String(req.params.id);
    const target = await db.query('SELECT * FROM users WHERE id = $1 AND org_id = $2', [targetId, org.id]);
    if (target.rows.length === 0) {
      res.status(404).json({ ok: false, error: 'Coach not found.' });
      return;
    }
    if (target.rows[0].role === 'owner') {
      res.status(400).json({ ok: false, error: 'The owner account cannot be changed here.' });
      return;
    }
    if (target.rows[0].role === 'parent') {
      res.status(400).json({
        ok: false,
        error: 'Parent accounts are managed from the player profile (Parents section), not here.',
      });
      return;
    }
    if (targetId === req.auth!.user.id) {
      res.status(400).json({ ok: false, error: 'You cannot change your own account here.' });
      return;
    }
    let cleanFullName: string | null = null;
    if (name !== undefined) {
      cleanFullName = cleanName(name);
      if (!cleanFullName) {
        res.status(400).json({ ok: false, error: 'Name must be a non-empty string of 100 characters or fewer.' });
        return;
      }
    }
    if (role !== undefined && !NON_OWNER_ROLES.includes(role as NonOwnerRole)) {
      res.status(400).json({ ok: false, error: "Role must be 'head_coach', 'assistant', or 'stat_crew'." });
      return;
    }
    let cleanTeams: string[] | null = null;
    if (teamIds !== undefined) {
      cleanTeams = cleanTeamIds(teamIds);
      if (!cleanTeams) {
        res.status(400).json({ ok: false, error: 'teamIds must be an array of team IDs.' });
        return;
      }
      if (cleanTeams.length > 0) {
        const teams = await db.query('SELECT id FROM teams WHERE org_id = $1 AND id = ANY($2)', [
          org.id,
          cleanTeams,
        ]);
        if (teams.rows.length !== cleanTeams.length) {
          res.status(400).json({ ok: false, error: 'One or more selected teams were not found.' });
          return;
        }
      }
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      if (cleanFullName !== null) {
        await client.query('UPDATE users SET name = $1 WHERE id = $2', [cleanFullName, targetId]);
      }
      if (role !== undefined) {
        await client.query('UPDATE users SET role = $1 WHERE id = $2', [role, targetId]);
      }
      if (cleanTeams !== null) {
        await client.query('DELETE FROM coach_teams WHERE user_id = $1', [targetId]);
        for (const teamId of cleanTeams) {
          await client.query('INSERT INTO coach_teams (user_id, team_id) VALUES ($1, $2)', [
            targetId,
            teamId,
          ]);
        }
      }
      await client.query('COMMIT');
      const coaches = await loadCoaches(db, org.id);
      res.json({ ok: true, coach: coaches.find((c) => c.id === targetId) });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);

app.delete(
  '/api/coaches/:id',
  requirePermission('coach_manage'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const targetId = String(req.params.id);
    const target = await db.query('SELECT * FROM users WHERE id = $1 AND org_id = $2', [targetId, org.id]);
    if (target.rows.length === 0) {
      res.status(404).json({ ok: false, error: 'Coach not found.' });
      return;
    }
    if (target.rows[0].role === 'owner') {
      res.status(400).json({ ok: false, error: 'The owner account cannot be deleted.' });
      return;
    }
    if (target.rows[0].role === 'parent') {
      res.status(400).json({
        ok: false,
        error: 'Parent accounts are managed from the player profile (Parents section), not here.',
      });
      return;
    }
    if (targetId === req.auth!.user.id) {
      res.status(400).json({ ok: false, error: 'You cannot delete your own account.' });
      return;
    }
    // Sessions + team assignments cascade off the user row.
    await db.query('DELETE FROM users WHERE id = $1', [targetId]);
    res.json({ ok: true, deleted: true });
  }),
);

// Owner-only password reset for a coach. Sets the coach's password and
// invalidates ALL of that coach's sessions (forces re-login). The owner
// cannot reset their own password here — use change-password — and
// cannot target the owner account.
app.post(
  '/api/coaches/:id/reset-password',
  requirePermission('coach_manage'),
  asyncHandler(async (req, res) => {
    const { newPassword } = req.body ?? {};
    const cleanNew = cleanPassword(newPassword);
    if (!cleanNew) {
      res.status(400).json({ ok: false, error: 'New password must be at least 8 characters.' });
      return;
    }
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const targetId = String(req.params.id);
    const target = await db.query('SELECT * FROM users WHERE id = $1 AND org_id = $2', [targetId, org.id]);
    if (target.rows.length === 0) {
      res.status(404).json({ ok: false, error: 'Coach not found.' });
      return;
    }
    if (target.rows[0].role === 'parent') {
      res.status(400).json({
        ok: false,
        error: 'Parent passwords are reset from the player profile (Parents section), not here.',
      });
      return;
    }
    if (target.rows[0].role === 'owner' || targetId === req.auth!.user.id) {
      res.status(403).json({ ok: false, error: 'Use change-password for your own account.' });
      return;
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
        hashPassword(cleanNew),
        targetId,
      ]);
      await client.query('DELETE FROM sessions WHERE user_id = $1', [targetId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.json({ ok: true, reset: true });
  }),
);

// ------------------------------------------------------ parent accounts
// Real parent logins (migration 012 — the owner chose real accounts
// over token links). A parent is a user with role 'parent', created by
// a head coach from a player's profile and linked to one or more
// players (parent_players) — their kids. Parents hold NO coach
// permissions (the role ranks below stat_crew, so every coach action
// 403s); their reads go through GET /api/parent/home, scoped
// server-side to their linked players only.
//
// Management is head_coach+ ('parent_manage') and team-scoped like
// everything else: a head coach manages the parents of players on
// their assigned teams; the owner manages every parent in the org.
// Asking about a parent outside that scope is a 404, exactly like an
// unassigned team.
const PARENT_MIGRATION_MESSAGE =
  'Parent accounts are not set up yet — run migrations/012_parent_accounts.sql in the Neon SQL Editor, then restart.';

function isMissingParentSchema(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === '42P01' || code === '42703';
}

/** A player the caller may see (owner: any org player; coach: players
 *  on assigned teams). Mirrors getOrgPlayer's scoping. */
async function getAccessiblePlayer(
  db: ReturnType<typeof getPool>,
  auth: ReturnType<typeof authOf>,
  playerId: string,
) {
  const row = await db.query(
    `SELECT p.* FROM players p JOIN teams t ON t.id = p.team_id
     WHERE t.org_id = $1 AND p.id = $2${auth.teamIds ? ' AND t.id = ANY($3)' : ''}`,
    auth.teamIds ? [auth.user.org_id, playerId, auth.teamIds] : [auth.user.org_id, playerId],
  );
  return row.rows[0] ?? null;
}

/** Parents visible to the caller, each with their linked player IDs.
 *  Owner: every parent in the org. Head coach: parents linked to at
 *  least one player on an assigned team. Never includes password_hash
 *  or any credential. */
async function loadOrgParents(
  db: ReturnType<typeof getPool>,
  orgId: string,
  auth: ReturnType<typeof authOf>,
) {
  const parents =
    auth.teamIds === null
      ? await db.query(
          `SELECT id, org_id, email, name, role, created_at FROM users
           WHERE org_id = $1 AND role = 'parent' ORDER BY created_at ASC`,
          [orgId],
        )
      : await db.query(
          `SELECT DISTINCT u.id, u.org_id, u.email, u.name, u.role, u.created_at
           FROM users u
           JOIN parent_players pp ON pp.user_id = u.id
           JOIN players p ON p.id = pp.player_id
           WHERE u.org_id = $1 AND u.role = 'parent' AND p.team_id = ANY($2)
           ORDER BY u.created_at ASC`,
          [orgId, auth.teamIds],
        );
  const ids = parents.rows.map((u) => u.id as string);
  const links =
    ids.length > 0
      ? await db.query('SELECT user_id, player_id FROM parent_players WHERE user_id = ANY($1)', [ids])
      : { rows: [] as { user_id: string; player_id: string }[] };
  const playerIdsByUser = new Map<string, string[]>();
  for (const l of links.rows) {
    const list = playerIdsByUser.get(l.user_id) ?? [];
    list.push(l.player_id);
    playerIdsByUser.set(l.user_id, list);
  }
  return parents.rows.map((u) => ({ ...publicUser(u), playerIds: playerIdsByUser.get(u.id) ?? [] }));
}

/** May the caller manage this parent? Owner: any parent in the org.
 *  Head coach: a parent linked to a player on an assigned team. */
async function canManageParent(
  db: ReturnType<typeof getPool>,
  auth: ReturnType<typeof authOf>,
  parentId: string,
): Promise<boolean> {
  const row = await db.query(
    "SELECT id FROM users WHERE id = $1 AND org_id = $2 AND role = 'parent'",
    [parentId, auth.user.org_id],
  );
  if (row.rows.length === 0) return false;
  if (auth.teamIds === null) return true;
  const link = await db.query(
    `SELECT 1 FROM parent_players pp JOIN players p ON p.id = pp.player_id
     WHERE pp.user_id = $1 AND p.team_id = ANY($2) LIMIT 1`,
    [parentId, auth.teamIds],
  );
  return link.rows.length > 0;
}

app.get(
  '/api/parents',
  requirePermission('parent_manage'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const auth = authOf(req);
    try {
      const org = await getOrCreateOrganization(auth.user.org_id);
      res.json({ ok: true, parents: await loadOrgParents(db, org.id, auth) });
    } catch (err) {
      if (isMissingParentSchema(err)) {
        res.status(503).json({ ok: false, error: PARENT_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

// Create a parent account AND link it to a player in one step (same
// validation + scrypt hashing as coach creation — POST /api/coaches).
app.post(
  '/api/parents',
  requirePermission('parent_manage'),
  asyncHandler(async (req, res) => {
    const { email, password, name, player_id } = req.body ?? {};
    const cleanMail = cleanEmail(email);
    const cleanPass = cleanPassword(password);
    const cleanFullName = cleanName(name);
    if (!cleanMail) {
      res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
      return;
    }
    if (!cleanPass) {
      res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
      return;
    }
    if (!cleanFullName) {
      res.status(400).json({ ok: false, error: 'Name is required (100 characters or fewer).' });
      return;
    }
    if (typeof player_id !== 'string' || !player_id) {
      res.status(400).json({ ok: false, error: 'player_id is required.' });
      return;
    }
    const db = getPool();
    const auth = authOf(req);
    try {
      const org = await getOrCreateOrganization(auth.user.org_id);
      const player = await getAccessiblePlayer(db, auth, player_id);
      if (!player) {
        res.status(404).json({ ok: false, error: 'Player not found.' });
        return;
      }
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const user = await client.query(
          `INSERT INTO users (org_id, email, password_hash, name, role)
           VALUES ($1, $2, $3, $4, 'parent')
           RETURNING id, org_id, email, name, role, created_at`,
          [org.id, cleanMail, hashPassword(cleanPass), cleanFullName],
        );
        await client.query('INSERT INTO parent_players (user_id, player_id) VALUES ($1, $2)', [
          user.rows[0].id,
          player_id,
        ]);
        await client.query('COMMIT');
        const parents = await loadOrgParents(db, org.id, auth);
        res.status(201).json({ ok: true, parent: parents.find((p) => p.id === user.rows[0].id) });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        res.status(400).json({ ok: false, error: 'That email is already registered.' });
        return;
      }
      if (isMissingParentSchema(err)) {
        res.status(503).json({ ok: false, error: PARENT_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

app.get(
  '/api/players/:playerId/parents',
  requirePermission('parent_manage'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const auth = authOf(req);
    try {
      const player = await getAccessiblePlayer(db, auth, String(req.params.playerId));
      if (!player) {
        res.status(404).json({ ok: false, error: 'Player not found.' });
        return;
      }
      const rows = await db.query(
        `SELECT u.id, u.org_id, u.email, u.name, u.role, u.created_at
         FROM users u JOIN parent_players pp ON pp.user_id = u.id
         WHERE pp.player_id = $1 AND u.org_id = $2
         ORDER BY u.created_at ASC`,
        [player.id, auth.user.org_id],
      );
      res.json({ ok: true, parents: rows.rows.map((u) => publicUser(u)) });
    } catch (err) {
      if (isMissingParentSchema(err)) {
        res.status(503).json({ ok: false, error: PARENT_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

// Link an EXISTING parent account to another player (a second kid, or
// a second parent for the same kid is the create flow above). The gate
// is the PLAYER's accessibility — linking this parent to your player
// is exactly what puts them in your management scope.
app.post(
  '/api/parents/:id/link',
  requirePermission('parent_manage'),
  asyncHandler(async (req, res) => {
    const { player_id } = req.body ?? {};
    if (typeof player_id !== 'string' || !player_id) {
      res.status(400).json({ ok: false, error: 'player_id is required.' });
      return;
    }
    const db = getPool();
    const auth = authOf(req);
    try {
      const parentId = String(req.params.id);
      const parent = await db.query(
        "SELECT id FROM users WHERE id = $1 AND org_id = $2 AND role = 'parent'",
        [parentId, auth.user.org_id],
      );
      if (parent.rows.length === 0) {
        res.status(404).json({ ok: false, error: 'Parent not found.' });
        return;
      }
      const player = await getAccessiblePlayer(db, auth, player_id);
      if (!player) {
        res.status(404).json({ ok: false, error: 'Player not found.' });
        return;
      }
      await db.query(
        'INSERT INTO parent_players (user_id, player_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [parentId, player_id],
      );
      res.json({ ok: true, linked: true });
    } catch (err) {
      if (isMissingParentSchema(err)) {
        res.status(503).json({ ok: false, error: PARENT_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

app.delete(
  '/api/parents/:id/link/:playerId',
  requirePermission('parent_manage'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const auth = authOf(req);
    try {
      const parentId = String(req.params.id);
      const parent = await db.query(
        "SELECT id FROM users WHERE id = $1 AND org_id = $2 AND role = 'parent'",
        [parentId, auth.user.org_id],
      );
      if (parent.rows.length === 0) {
        res.status(404).json({ ok: false, error: 'Parent not found.' });
        return;
      }
      const player = await getAccessiblePlayer(db, auth, String(req.params.playerId));
      if (!player) {
        res.status(404).json({ ok: false, error: 'Player not found.' });
        return;
      }
      await db.query('DELETE FROM parent_players WHERE user_id = $1 AND player_id = $2', [
        parentId,
        player.id,
      ]);
      res.json({ ok: true, unlinked: true });
    } catch (err) {
      if (isMissingParentSchema(err)) {
        res.status(503).json({ ok: false, error: PARENT_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

// Delete a parent account (sessions + player links cascade). BLOCKED
// while the parent owns imported videos: those rows point at the
// parent's own Drive connection, and deleting the account would
// orphan the library entries coaches may already have clipped into
// reels. Delete the imports first (Highlight Builder library), then
// the account.
app.delete(
  '/api/parents/:id',
  requirePermission('parent_manage'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const auth = authOf(req);
    try {
      const parentId = String(req.params.id);
      if (!(await canManageParent(db, auth, parentId))) {
        res.status(404).json({ ok: false, error: 'Parent not found.' });
        return;
      }
      const videos = await db
        .query('SELECT COUNT(*)::int AS n FROM imported_videos WHERE owner_user_id = $1', [parentId])
        .catch((err) => {
          // Migration 011 not run → no imports can exist.
          if (isMissingParentSchema(err)) return { rows: [{ n: 0 }] };
          throw err;
        });
      if (videos.rows[0].n > 0) {
        res.status(400).json({
          ok: false,
          error:
            'This parent has imported videos in the library — delete their imports first (Highlight Builder), then remove the account.',
        });
        return;
      }
      await db.query('DELETE FROM users WHERE id = $1', [parentId]);
      res.json({ ok: true, deleted: true });
    } catch (err) {
      if (isMissingParentSchema(err)) {
        res.status(503).json({ ok: false, error: PARENT_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

// Head-coach password reset for a parent they manage — mirrors the
// owner→coach reset (sets the hash, invalidates ALL of the parent's
// sessions). Share the new password out-of-band; there is no
// email-based reset.
app.post(
  '/api/parents/:id/reset-password',
  requirePermission('parent_manage'),
  asyncHandler(async (req, res) => {
    const { newPassword } = req.body ?? {};
    const cleanNew = cleanPassword(newPassword);
    if (!cleanNew) {
      res.status(400).json({ ok: false, error: 'New password must be at least 8 characters.' });
      return;
    }
    const db = getPool();
    const auth = authOf(req);
    try {
      const parentId = String(req.params.id);
      if (!(await canManageParent(db, auth, parentId))) {
        res.status(404).json({ ok: false, error: 'Parent not found.' });
        return;
      }
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
          hashPassword(cleanNew),
          parentId,
        ]);
        await client.query('DELETE FROM sessions WHERE user_id = $1', [parentId]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      res.json({ ok: true, reset: true });
    } catch (err) {
      if (isMissingParentSchema(err)) {
        res.status(503).json({ ok: false, error: PARENT_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

// ------------------------------------------------------- parent's home
// The parent's whole world in one call, scoped to their linked
// players: player + team, the recruiting profile (bio/measurables +
// aggregated stats + highlights — the same computation coaches see),
// the published public-profile path when one exists, and the team's
// PUBLISHED games with their public watch paths. Nothing else about
// the org leaves the API — no rosters, no other players, no drafts.
app.get(
  '/api/parent/home',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    if (auth.user.role !== 'parent') {
      res.status(403).json({ ok: false, error: 'Parent accounts only.' });
      return;
    }
    const db = getPool();
    try {
      const org = await getOrCreateOrganization(auth.user.org_id);
      const linked = await db.query(
        `SELECT p.id, p.name, p.jersey_number, p.position, p.team_id,
                t.name AS team_name, t.sport AS team_sport
         FROM parent_players pp
         JOIN players p ON p.id = pp.player_id
         JOIN teams t ON t.id = p.team_id
         WHERE pp.user_id = $1 AND t.org_id = $2
         ORDER BY p.created_at ASC`,
        [auth.user.id, org.id],
      );
      const players = [];
      for (const p of linked.rows) {
        const profileRow = await db.query('SELECT * FROM player_profiles WHERE player_id = $1', [p.id]);
        const prof = profileRow.rows[0] ?? null;
        const stats = await computePlayerStats(db, p.id as string);
        const games = await db.query(
          `SELECT id, opponent, status, our_score, opponent_score, period_label, created_at, publish_token
           FROM games
           WHERE team_id = $1 AND published = true AND publish_token IS NOT NULL
           ORDER BY created_at DESC
           LIMIT 20`,
          [p.team_id],
        );
        players.push({
          id: p.id as string,
          name: p.name as string,
          jersey_number: p.jersey_number as string,
          position: p.position as string,
          team_id: p.team_id as string,
          team_name: p.team_name as string,
          team_sport: p.team_sport as string,
          profile: prof
            ? {
                bio: prof.bio as string,
                height: prof.height as string,
                graduation_year: prof.graduation_year as string,
                positions_text: prof.positions_text as string,
                school: prof.school as string,
                club_team: prof.club_team as string,
              }
            : null,
          profile_public_path:
            prof && prof.profile_published && prof.profile_token
              ? `/profile/${prof.profile_token as string}`
              : null,
          stats,
          games: games.rows.map((g) => ({
            id: g.id as string,
            opponent: g.opponent as string,
            status: g.status as string,
            our_score: g.our_score as number,
            opponent_score: g.opponent_score as number,
            period_label: g.period_label as string,
            created_at: g.created_at as string,
            watch_path: `/watch/${g.publish_token as string}`,
          })),
        });
      }
      res.json({
        ok: true,
        organization: {
          id: org.id,
          name: org.name,
          primary_color: org.primary_color,
          secondary_color: org.secondary_color,
        },
        players,
      });
    } catch (err) {
      if (isMissingParentSchema(err)) {
        res.status(503).json({ ok: false, error: PARENT_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

// ------------------------------------------------------------- workspace
// Full state in one call: org, teams, players, games, events, lineups.
app.get(
  '/api/workspace',
  asyncHandler(async (req, res) => {
    const db = getPool();
    const auth = authOf(req);
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
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
    // Events/lineups carry a game_id, not a team_id — map through the
    // games the caller may see.
    const visibleGames = games.rows.filter((g) => canAccessTeam(auth, g.team_id));
    const gameTeamIds = new Set(visibleGames.map((g) => g.id));
    res.json({
      ok: true,
      organization: org,
      // Non-owners see only their assigned teams — and only the
      // players, games, events, and lineups that belong to those teams.
      // Filtered server-side before anything leaves the API.
      teams: teams.rows.filter((t) => canAccessTeam(auth, t.id)),
      players: players.rows.filter((p) => canAccessTeam(auth, p.team_id)),
      games: visibleGames,
      events: events.rows.filter((e) => gameTeamIds.has(e.game_id)),
      lineups: lineups.rows.filter((l) => gameTeamIds.has(l.game_id)),
    });
  }),
);

// ------------------------------------------------------------ organization
// Rename the organization. Trims, requires a non-empty name, max 100 chars.
app.patch(
  '/api/organization',
  requirePermission('org'),
  asyncHandler(async (req, res) => {
    const { name } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ ok: false, error: 'Organization name is required.' });
      return;
    }
    if (name.trim().length > 100) {
      res.status(400).json({ ok: false, error: 'Organization name must be 100 characters or fewer.' });
      return;
    }
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const result = await db.query('UPDATE organizations SET name = $1 WHERE id = $2 RETURNING *', [
      name.trim(),
      org.id,
    ]);
    res.json({ ok: true, organization: result.rows[0] });
  }),
);

// ----------------------------------------------------------------- teams
app.post(
  '/api/teams',
  requirePermission('team_create'),
  asyncHandler(async (req, res) => {
    const { name, sport, season } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ ok: false, error: 'Team name is required.' });
      return;
    }
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
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
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    if (!canAccessTeam(authOf(req), String(req.params.teamId))) {
      res.status(404).json({ ok: false, error: 'Team not found.' });
      return;
    }
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
  requirePermission('roster'),
  asyncHandler(async (req, res) => {
    const { name, jersey_number, position } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ ok: false, error: 'Player name is required.' });
      return;
    }
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    // Confirm the team belongs to this org before inserting.
    const team = await db.query('SELECT id FROM teams WHERE id = $1 AND org_id = $2', [
      req.params.teamId,
      org.id,
    ]);
    if (team.rows.length === 0 || !canAccessTeam(authOf(req), String(req.params.teamId))) {
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

// ------------------------------------------------------- player profiles
// Recruiting profile: coach-editable bio + measurables (player_profiles),
// stats auto-aggregated from the player's own game_events, and the same
// unlisted token-only publish model as game watch links (002).
//
// Stats shape: career totals by stat type (exactly the stat types the
// app logs — Kill, Ace, Block, Dig, Assist, Attack Attempt, Serve Error,
// Passing Error, Substitution, Opponent point), plus a per-game
// breakdown. There is no season field on games in this schema, so
// "season" is not a separate bucket — career totals + per-game is the
// honest shape. Points only count for our side: a Serve Error /
// Passing Error is recorded with side 'opponent' and its point belongs
// to the opponent, not to the player who made the error.
async function getOrgPlayer(
  db: ReturnType<typeof getPool>,
  req: express.Request,
  playerId: string,
) {
  const auth = authOf(req);
  const teamIds = auth.teamIds;
  const player = await db.query(
    `SELECT p.* FROM players p JOIN teams t ON t.id = p.team_id
     WHERE t.org_id = $1 AND p.id = $2${teamIds ? ' AND t.id = ANY($3)' : ''}`,
    teamIds ? [auth.user.org_id, playerId, teamIds] : [auth.user.org_id, playerId],
  );
  return player.rows[0] ?? null;
}

// Aggregate one player's events. Highlights = the player's own tracked
// events (Substitution excluded — a lineup event, not a highlight), each
// with its game's video id + timestamp so it links back to film.
async function computePlayerStats(db: ReturnType<typeof getPool>, playerId: string) {
  const events = await db.query(
    `SELECT e.stat_type, e.side, e.points, e.video_seconds, e.created_at,
            g.opponent, g.youtube_video_id
     FROM game_events e JOIN games g ON g.id = e.game_id
     WHERE e.player_id = $1
     ORDER BY e.created_at ASC, e.id ASC`,
    [playerId],
  );
  const totals: Record<string, number> = {};
  let totalPoints = 0;
  const byGameMap = new Map<
    string,
    { opponent: string; date: string; stats: Record<string, number>; points: number }
  >();
  const highlights: {
    stat_type: string;
    points: number;
    video_seconds: number;
    created_at: string;
    opponent: string;
    youtube_video_id: string | null;
  }[] = [];
  for (const e of events.rows) {
    totals[e.stat_type] = (totals[e.stat_type] ?? 0) + 1;
    // Our-side points only — an opponent-side point (e.g. our Serve
    // Error) is the opponent's point, not this player's.
    if (e.side === 'ours') {
      totalPoints += e.points;
    }
    const key = `${e.opponent}|${e.created_at.slice(0, 10)}`;
    let gameEntry = byGameMap.get(key);
    if (!gameEntry) {
      gameEntry = { opponent: e.opponent, date: e.created_at.slice(0, 10), stats: {}, points: 0 };
      byGameMap.set(key, gameEntry);
    }
    gameEntry.stats[e.stat_type] = (gameEntry.stats[e.stat_type] ?? 0) + 1;
    if (e.side === 'ours') {
      gameEntry.points += e.points;
    }
    if (e.stat_type !== 'Substitution') {
      highlights.push({
        stat_type: e.stat_type,
        points: e.points,
        video_seconds: e.video_seconds,
        created_at: e.created_at,
        opponent: e.opponent,
        youtube_video_id: e.youtube_video_id,
      });
    }
  }
  return {
    totals,
    totalPoints,
    gamesPlayed: byGameMap.size,
    byGame: [...byGameMap.values()],
    // Newest first for the highlights list.
    highlights: highlights.reverse(),
  };
}

// Length caps for coach-editable profile fields.
const PROFILE_FIELD_MAX = { bio: 2000, measurables: 100 };

function cleanProfileField(value: unknown, max: number): string | null {
  if (value === undefined) return null; // field not sent — leave as-is
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length > max) return '__TOO_LONG__';
  return trimmed;
}

app.get(
  '/api/players/:playerId/profile',
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const playerId = String(req.params.playerId);
    const player = await getOrgPlayer(db, req, playerId);
    if (!player) {
      res.status(404).json({ ok: false, error: 'Player not found.' });
      return;
    }
    const profile = await db.query('SELECT * FROM player_profiles WHERE player_id = $1', [playerId]);
    const stats = await computePlayerStats(db, playerId);
    res.json({ ok: true, player, profile: profile.rows[0] ?? null, stats });
  }),
);

app.patch(
  '/api/players/:playerId/profile',
  requirePermission('profile_edit'),
  asyncHandler(async (req, res) => {
    const { bio, height, graduation_year, positions_text, school, club_team } = req.body ?? {};
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const playerId = String(req.params.playerId);
    const player = await getOrgPlayer(db, req, playerId);
    if (!player) {
      res.status(404).json({ ok: false, error: 'Player not found.' });
      return;
    }
    // Validate each sent field: strings only, within the length caps.
    const fields: Record<string, string> = {};
    const incoming: Record<string, unknown> = { bio, height, graduation_year, positions_text, school, club_team };
    for (const [key, value] of Object.entries(incoming)) {
      if (value === undefined) continue;
      const max = key === 'bio' ? PROFILE_FIELD_MAX.bio : PROFILE_FIELD_MAX.measurables;
      const cleaned = cleanProfileField(value, max);
      if (cleaned === null) {
        res.status(400).json({ ok: false, error: `${key} must be a string.` });
        return;
      }
      if (cleaned === '__TOO_LONG__') {
        res.status(400).json({ ok: false, error: `${key} must be ${max} characters or fewer.` });
        return;
      }
      fields[key] = cleaned;
    }
    // Upsert: a profile row is created on first edit, so there is no
    // separate "create profile" step.
    const sets = Object.keys(fields).map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = Object.values(fields);
    let result;
    if (sets.length > 0) {
      result = await db.query(
        `INSERT INTO player_profiles (player_id, ${Object.keys(fields).join(', ')})
         VALUES ($1, ${values.map((_, i) => `$${i + 2}`).join(', ')})
         ON CONFLICT (player_id) DO UPDATE SET ${sets}, updated_at = now()
         RETURNING *`,
        [playerId, ...values],
      );
    } else {
      result = await db.query(
        `INSERT INTO player_profiles (player_id) VALUES ($1)
         ON CONFLICT (player_id) DO NOTHING RETURNING *`,
        [playerId],
      );
      if (result.rows.length === 0) {
        result = await db.query('SELECT * FROM player_profiles WHERE player_id = $1', [playerId]);
      }
    }
    res.json({ ok: true, profile: result.rows[0] });
  }),
);

// Profile publish/unpublish/revoke — same token model as game publish:
// publish reuses an existing token (or mints one); revoke mints a fresh
// token so the old link dies while the published flag stays as-is.
app.post(
  '/api/players/:playerId/profile/publish',
  requirePermission('publish'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const playerId = String(req.params.playerId);
    const player = await getOrgPlayer(db, req, playerId);
    if (!player) {
      res.status(404).json({ ok: false, error: 'Player not found.' });
      return;
    }
    const existing = await db.query('SELECT * FROM player_profiles WHERE player_id = $1', [playerId]);
    const token = existing.rows[0]?.profile_token ?? newPublishToken();
    const result = await db.query(
      `INSERT INTO player_profiles (player_id, profile_token, profile_published)
       VALUES ($1, $2, true)
       ON CONFLICT (player_id) DO UPDATE SET profile_token = $2, profile_published = true, updated_at = now()
       RETURNING *`,
      [playerId, token],
    );
    res.json({ ok: true, profile: result.rows[0], publicPath: `/profile/${token}` });
  }),
);

app.post(
  '/api/players/:playerId/profile/unpublish',
  requirePermission('publish'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const playerId = String(req.params.playerId);
    const player = await getOrgPlayer(db, req, playerId);
    if (!player) {
      res.status(404).json({ ok: false, error: 'Player not found.' });
      return;
    }
    const result = await db.query(
      `INSERT INTO player_profiles (player_id, profile_published) VALUES ($1, false)
       ON CONFLICT (player_id) DO UPDATE SET profile_published = false, updated_at = now()
       RETURNING *`,
      [playerId],
    );
    res.json({ ok: true, profile: result.rows[0] });
  }),
);

app.post(
  '/api/players/:playerId/profile/revoke',
  requirePermission('publish'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const playerId = String(req.params.playerId);
    const player = await getOrgPlayer(db, req, playerId);
    if (!player) {
      res.status(404).json({ ok: false, error: 'Player not found.' });
      return;
    }
    const token = newPublishToken();
    const result = await db.query(
      `INSERT INTO player_profiles (player_id, profile_token) VALUES ($1, $2)
       ON CONFLICT (player_id) DO UPDATE SET profile_token = $2, updated_at = now()
       RETURNING *`,
      [playerId, token],
    );
    res.json({ ok: true, profile: result.rows[0], publicPath: `/profile/${token}` });
  }),
);

// ----------------------------------------------------------------- games
app.post(
  '/api/games',
  requirePermission('game_create'),
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
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const team = await db.query('SELECT id FROM teams WHERE id = $1 AND org_id = $2', [team_id, org.id]);
    if (team.rows.length === 0 || !canAccessTeam(authOf(req), team_id)) {
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
      // live screen has on-court cards immediately. Coaches swap players
      // via subs (POST /api/games/:id/sub).
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
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const game = await db.query(
      `SELECT g.* FROM games g JOIN teams t ON t.id = g.team_id
       WHERE t.org_id = $1 AND g.id = $2`,
      [org.id, req.params.gameId],
    );
    if (game.rows.length === 0 || !canAccessTeam(authOf(req), game.rows[0].team_id)) {
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

// ------------------------------------------------------------ set lineup
// Set the starting 6 for a DRAFT game — the lineup step of the Live
// tab's Start Live Game flow. Exactly 6 unique players, all from the
// game's team, replacing whatever lineup rows exist (game creation
// seeds the first 6; this lets the coach pick their own 6). Draft-only:
// once a game is live, lineup changes go through subs. Gated on
// 'game_create' (head_coach) — lineup setup is part of game setup, so
// no new permission action was added.
app.post(
  '/api/games/:gameId/lineup',
  requirePermission('game_create'),
  asyncHandler(async (req, res) => {
    const { player_ids } = req.body ?? {};
    if (
      !Array.isArray(player_ids) ||
      player_ids.length !== 6 ||
      new Set(player_ids).size !== 6 ||
      !player_ids.every((id) => typeof id === 'string')
    ) {
      res.status(400).json({ ok: false, error: 'Pick exactly 6 starting players.' });
      return;
    }
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const game = await getOrgGame(db, req, String(req.params.gameId));
    if (!game) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    if (game.status !== 'draft') {
      res
        .status(400)
        .json({ ok: false, error: 'The starting lineup can only be set before a game goes live — use subs once live.' });
      return;
    }
    const roster = await db.query('SELECT id FROM players WHERE team_id = $1 AND id = ANY($2)', [
      game.team_id,
      player_ids,
    ]);
    if (roster.rows.length !== 6) {
      res.status(400).json({ ok: false, error: 'All 6 starters must be on this team\u2019s roster.' });
      return;
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM lineups WHERE game_id = $1', [game.id]);
      for (let i = 0; i < player_ids.length; i++) {
        await client.query('INSERT INTO lineups (game_id, player_id, slot) VALUES ($1, $2, $3)', [
          game.id,
          player_ids[i],
          i,
        ]);
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);

// -------------------------------------------------------- game status
// Status transitions: draft → live ("Go Live"), live → final ("End
// Game"). Anything else is a 400 with a plain explanation — a final game
// is done, and a draft must go live before it can be ended. The
// transition is recorded as a game_event (stat_type 'Game started' /
// 'Game ended', player_id NULL) so it shows in the timeline and the
// public watch feed, and status + event land in one transaction. The
// stat_type values follow the existing Title Case phrase convention
// ('Opponent point', 'Attack attempt', …) and never touch player stats,
// because player aggregation filters on player_id.
app.patch(
  '/api/games/:gameId/status',
  requirePermission('game_status'),
  asyncHandler(async (req, res) => {
    const { status } = req.body ?? {};
    if (status !== 'draft' && status !== 'live' && status !== 'final') {
      res.status(400).json({ ok: false, error: "status must be 'draft', 'live', or 'final'." });
      return;
    }
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const game = await getOrgGame(db, req, String(req.params.gameId));
    if (!game) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    const current = game.status as 'draft' | 'live' | 'final';
    const allowed: Record<string, string[]> = { draft: ['live'], live: ['final'], final: [] };
    if (current === status) {
      res.status(400).json({ ok: false, error: `This game is already ${current}.` });
      return;
    }
    if (!allowed[current].includes(status)) {
      const reason =
        current === 'final'
          ? 'This game is already final — its status can no longer change.'
          : current === 'draft'
            ? 'A game must go live before it can be ended — go live first.'
            : 'A live game can only be ended, not sent back to draft.';
      res.status(400).json({ ok: false, error: reason });
      return;
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query('UPDATE games SET status = $1 WHERE id = $2 RETURNING *', [
        status,
        game.id,
      ]);
      await client.query(
        `INSERT INTO game_events (game_id, player_id, stat_type, side, points, video_seconds, entry_method)
         VALUES ($1, NULL, $2, 'ours', 0, 0, 'live')`,
        [game.id, status === 'live' ? 'Game started' : 'Game ended'],
      );
      await client.query('COMMIT');
      const updatedGame = updated.rows[0];
      // Go Live → text families the watch link, AFTER the transition
      // commits. Fire-and-forget: sending must never block the
      // transition or fail it. Only published games have a link to send;
      // sendGameSms no-ops for unpublished games.
      if (status === 'live') {
        void sendGameSms(db, updatedGame, 'go_live').catch((err) => {
          console.error('Go-live SMS failed:', err);
        });
      }
      res.json({ ok: true, game: updatedGame });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);

// ------------------------------------------------------------ stat events
// The core loop: tap a player, tap a stat, the event lands with a score
// update in the same transaction so the two can never drift apart.
app.post(
  '/api/games/:gameId/events',
  requirePermission('tag_stats'),
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
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const game = await db.query(
      `SELECT g.* FROM games g JOIN teams t ON t.id = g.team_id
       WHERE t.org_id = $1 AND g.id = $2`,
      [org.id, req.params.gameId],
    );
    if (game.rows.length === 0 || !canAccessTeam(authOf(req), game.rows[0].team_id)) {
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
// When the most recent event is a Substitution recorded with
// out_player_id (migration 005), the lineup swap is reversed too — the
// out-player returns to the slot and the in-player returns to the bench —
// in the same transaction. Subs recorded before 005 have out_player_id
// NULL and fall back to deleting the event only.
app.post(
  '/api/games/:gameId/undo',
  requirePermission('tag_stats'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const game = await db.query(
      `SELECT g.* FROM games g JOIN teams t ON t.id = g.team_id
       WHERE t.org_id = $1 AND g.id = $2`,
      [org.id, req.params.gameId],
    );
    if (game.rows.length === 0 || !canAccessTeam(authOf(req), game.rows[0].team_id)) {
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
      // Reverse a Substitution: the in-player (event.player_id) leaves
      // the slot and the out-player takes it back. If the in-player is
      // somehow no longer on the court, the swap is skipped rather than
      // failing the whole undo — the event is already deleted above.
      if (event.stat_type === 'Substitution' && event.out_player_id && event.player_id) {
        await client.query(
          'UPDATE lineups SET player_id = $1 WHERE game_id = $2 AND player_id = $3',
          [event.out_player_id, req.params.gameId, event.player_id],
        );
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

// ------------------------------------------------------------ substitution
// Swap a bench player onto the court. The in-player takes the out-player's
// slot so slot numbers stay stable. Recorded as a game_event (stat_type
// 'Substitution', player_id = the player coming in, out_player_id = the
// player going out) so it shows in the timeline and undo can reverse the
// swap. Lineup swap + event land in one transaction.
app.post(
  '/api/games/:gameId/sub',
  requirePermission('sub'),
  asyncHandler(async (req, res) => {
    const { outPlayerId, inPlayerId } = req.body ?? {};
    if (typeof outPlayerId !== 'string' || !outPlayerId) {
      res.status(400).json({ ok: false, error: 'outPlayerId is required.' });
      return;
    }
    if (typeof inPlayerId !== 'string' || !inPlayerId) {
      res.status(400).json({ ok: false, error: 'inPlayerId is required.' });
      return;
    }
    if (outPlayerId === inPlayerId) {
      res.status(400).json({
        ok: false,
        error: 'The player coming in must be different from the player going out.',
      });
      return;
    }
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const game = await db.query(
      `SELECT g.* FROM games g JOIN teams t ON t.id = g.team_id
       WHERE t.org_id = $1 AND g.id = $2`,
      [org.id, req.params.gameId],
    );
    if (game.rows.length === 0 || !canAccessTeam(authOf(req), game.rows[0].team_id)) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    // Both players must belong to the game's team.
    const roster = await db.query('SELECT id FROM players WHERE team_id = $1 AND id IN ($2, $3)', [
      game.rows[0].team_id,
      outPlayerId,
      inPlayerId,
    ]);
    if (roster.rows.length !== 2) {
      res.status(400).json({ ok: false, error: "Both players must be on the game's team." });
      return;
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Out-player must currently be on the court.
      const outRow = await client.query('SELECT * FROM lineups WHERE game_id = $1 AND player_id = $2', [
        req.params.gameId,
        outPlayerId,
      ]);
      if (outRow.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(400).json({ ok: false, error: 'The player going out is not on the court.' });
        return;
      }
      // In-player must currently be on the bench.
      const inRow = await client.query('SELECT * FROM lineups WHERE game_id = $1 AND player_id = $2', [
        req.params.gameId,
        inPlayerId,
      ]);
      if (inRow.rows.length > 0) {
        await client.query('ROLLBACK');
        res.status(400).json({ ok: false, error: 'The player coming in is already on the court.' });
        return;
      }
      // Keep the slot: the in-player takes the out-player's slot.
      await client.query('UPDATE lineups SET player_id = $1 WHERE game_id = $2 AND player_id = $3', [
        inPlayerId,
        req.params.gameId,
        outPlayerId,
      ]);
      const event = await client.query(
        `INSERT INTO game_events (game_id, player_id, stat_type, side, points, video_seconds, entry_method, out_player_id)
         VALUES ($1, $2, 'Substitution', 'ours', 0, 0, 'live', $3) RETURNING *`,
        [req.params.gameId, inPlayerId, outPlayerId],
      );
      await client.query('COMMIT');
      res.json({ ok: true, event: event.rows[0] });
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
  requirePermission('youtube'),
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
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    // Team-scoped fetch FIRST — the UPDATE must never run on a game
    // the caller can't see.
    const game = await getOrgGame(db, req, String(req.params.gameId));
    if (!game) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    const result = await db.query('UPDATE games SET youtube_video_id = $1 WHERE id = $2 RETURNING *', [
      videoId,
      game.id,
    ]);
    if (result.rows.length === 0) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    res.json({ ok: true, game: result.rows[0] });
  }),
);

// ------------------------------------------------- publishing (coach)
// Unlisted watch links: a game is public only when published = true AND
// the caller presents the exact token. Publish reuses an existing token
// (or mints one); revoke mints a fresh token so the old link dies while
// the published flag stays as-is. All three are coach-side (org-scoped).
async function getOrgGame(db: ReturnType<typeof getPool>, req: express.Request, gameId: string) {
  const auth = authOf(req);
  const teamIds = auth.teamIds;
  const game = await db.query(
    `SELECT g.* FROM games g JOIN teams t ON t.id = g.team_id
     WHERE t.org_id = $1 AND g.id = $2${teamIds ? ' AND t.id = ANY($3)' : ''}`,
    teamIds ? [auth.user.org_id, gameId, teamIds] : [auth.user.org_id, gameId],
  );
  return game.rows[0] ?? null;
}

// 64 hex chars from 32 random bytes — unguessable, no sequential IDs.
function newPublishToken() {
  return crypto.randomBytes(32).toString('hex');
}

app.post(
  '/api/games/:gameId/publish',
  requirePermission('publish'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    // :gameId is always a single segment; String() normalizes Express 5's
    // `string | string[]` param type for the typed helper below.
    const gameId = String(req.params.gameId);
    const game = await getOrgGame(db, req, gameId);
    if (!game) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    const token = game.publish_token ?? newPublishToken();
    const result = await db.query(
      'UPDATE games SET publish_token = $1, published = true WHERE id = $2 RETURNING *',
      [token, gameId],
    );
    res.json({ ok: true, game: result.rows[0], publicPath: `/watch/${token}` });
  }),
);

app.post(
  '/api/games/:gameId/unpublish',
  requirePermission('publish'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const gameId = String(req.params.gameId);
    const game = await getOrgGame(db, req, gameId);
    if (!game) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    const result = await db.query('UPDATE games SET published = false WHERE id = $1 RETURNING *', [
      gameId,
    ]);
    res.json({ ok: true, game: result.rows[0] });
  }),
);

app.post(
  '/api/games/:gameId/revoke',
  requirePermission('publish'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const gameId = String(req.params.gameId);
    const game = await getOrgGame(db, req, gameId);
    if (!game) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    const token = newPublishToken();
    const result = await db.query('UPDATE games SET publish_token = $1 WHERE id = $2 RETURNING *', [
      token,
      gameId,
    ]);
    res.json({ ok: true, game: result.rows[0], publicPath: `/watch/${token}` });
  }),
);

// ------------------------------------------------- public watch (no auth)
// Serves ONLY the exact token. Bad tokens, revoked tokens, and
// unpublished games all get the identical generic 404 — the response
// never reveals which case it is. The payload exposes ONLY this game's
// public surface: team name, opponent, score, stream, event feed, and
// per-player scoring stats for this game. No rosters, no other games,
// no org details, no internal IDs.
app.get(
  '/api/public/watch/:token',
  asyncHandler(async (req, res) => {
    const db = getPool();
    const game = await db.query(
      `SELECT g.id, g.opponent, g.sport, g.mode, g.status, g.period_label,
              g.our_score, g.opponent_score, g.youtube_video_id,
              t.name AS team_name,
              o.primary_color, o.secondary_color
       FROM games g JOIN teams t ON t.id = g.team_id
       JOIN organizations o ON o.id = t.org_id
       WHERE g.publish_token = $1 AND g.published = true`,
      [req.params.token],
    );
    if (game.rows.length === 0) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    const g = game.rows[0];
    const events = await db.query(
      `SELECT e.stat_type, e.side, e.points, e.created_at,
              p.name AS player_name, p.jersey_number
       FROM game_events e
       LEFT JOIN players p ON p.id = e.player_id
       WHERE e.game_id = $1
       ORDER BY e.created_at DESC, e.id DESC`,
      [g.id],
    );
    // Box score: per-player scoring stats for THIS game only. Players
    // appear here only because they have events in this game's feed.
    const boxByName = new Map<
      string,
      { name: string; jersey_number: string; points: number; stats: Record<string, number> }
    >();
    for (const e of events.rows) {
      if (!e.player_name) continue;
      let entry = boxByName.get(e.player_name);
      if (!entry) {
        entry = {
          name: e.player_name,
          jersey_number: e.jersey_number ?? '',
          points: 0,
          stats: {},
        };
        boxByName.set(e.player_name, entry);
      }
      entry.stats[e.stat_type] = (entry.stats[e.stat_type] ?? 0) + 1;
      // Our-side points only — an opponent-side point (e.g. our Serve
      // Error) is the opponent's point, not this player's.
      if (e.side === 'ours') {
        entry.points += e.points;
      }
    }
    res.json({
      ok: true,
      watch: {
        team_name: g.team_name,
        opponent: g.opponent,
        sport: g.sport,
        mode: g.mode,
        status: g.status,
        period_label: g.period_label,
        our_score: g.our_score,
        opponent_score: g.opponent_score,
        youtube_video_id: g.youtube_video_id,
        events: events.rows,
        boxScore: [...boxByName.values()],
        // Org brand colors: the public Watch page wears the club's
        // colors (Llamas blue), not the SimpliGame shell palette.
        primary_color: g.primary_color,
        secondary_color: g.secondary_color,
      },
    });
  }),
);

// --------------------------------------------- public profile (no auth)
// Serves ONLY the exact token. Bad tokens, revoked tokens, and
// unpublished profiles all get the identical generic 404 — the response
// never reveals which case it is. The payload exposes ONLY this
// player's public surface: name, jersey, team, bio, measurables,
// aggregated stats, and highlight events with video links. No roster,
// no other players, no org details, no internal IDs.
app.get(
  '/api/public/profile/:token',
  asyncHandler(async (req, res) => {
    const db = getPool();
    const row = await db.query(
      `SELECT p.id, p.name, p.jersey_number, p.position, t.name AS team_name,
              o.primary_color, o.secondary_color
       FROM player_profiles pp
       JOIN players p ON p.id = pp.player_id
       JOIN teams t ON t.id = p.team_id
       JOIN organizations o ON o.id = t.org_id
       WHERE pp.profile_token = $1 AND pp.profile_published = true`,
      [req.params.token],
    );
    if (row.rows.length === 0) {
      res.status(404).json({ ok: false, error: 'Profile not found.' });
      return;
    }
    const player = row.rows[0];
    const profile = await db.query('SELECT * FROM player_profiles WHERE player_id = $1', [player.id]);
    const prof = profile.rows[0];
    const stats = await computePlayerStats(db, player.id);
    res.json({
      ok: true,
      profile: {
        name: player.name,
        jersey_number: player.jersey_number,
        position: player.position,
        team_name: player.team_name,
        bio: prof.bio,
        height: prof.height,
        graduation_year: prof.graduation_year,
        positions_text: prof.positions_text,
        school: prof.school,
        club_team: prof.club_team,
        stats,
        // Org brand colors: the public Profile page wears the club's
        // colors (Llamas blue), not the SimpliGame shell palette.
        primary_color: player.primary_color,
        secondary_color: player.secondary_color,
      },
    });
  }),
);

// ------------------------------------------- reel projects (Reel Studio)
// Reel Studio + Auto Reel. A project is an ordered list of clips stored
// as JSONB on reel_projects. Music tracks are placeholder names only —
// no real audio files, no audio playback in this round. Export is a
// mock: POST /:id/export returns an honest placeholder record, never a
// real MP4. Real video rendering is a later production build.
//
// Clip shape: { eventId, gameId, videoId, startSeconds, endSeconds,
//   transition: 'cut'|'fade', overlay, slowMo }.
const REEL_CLIP_MAX = 50;
const REEL_OVERLAY_MAX = 200;
const REEL_SECONDS_MAX = 36000; // 10 hours — generous sanity cap

// Built-in placeholder music tracks (names only, clearly labeled).
const MUSIC_TRACKS = [
  { id: 'none', name: 'No music' },
  { id: 'hype-energy', name: 'Hype Energy (placeholder)' },
  { id: 'pump-up', name: 'Pump Up (placeholder)' },
  { id: 'chill-warmup', name: 'Chill Warm-Up (placeholder)' },
  { id: 'cinematic', name: 'Cinematic (placeholder)' },
];

// Auto Reel presets: transitions + overlays + a placeholder music track.
const AUTO_PRESETS = {
  hype: { transition: 'fade', overlays: true, music: 'hype-energy' },
  clean: { transition: 'cut', overlays: true, music: 'cinematic' },
  simple: { transition: 'cut', overlays: false, music: 'none' },
} as const;

type AutoPresetName = keyof typeof AUTO_PRESETS;

function cleanReelClip(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  const c = value as Record<string, unknown>;
  const start = Number(c.startSeconds);
  const end = Number(c.endSeconds);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end <= start || end > REEL_SECONDS_MAX) return null;
  if (c.transition !== 'cut' && c.transition !== 'fade') return null;
  if (typeof c.overlay !== 'string' || c.overlay.length > REEL_OVERLAY_MAX) return null;
  if (typeof c.slowMo !== 'boolean') return null;
  // Imported-video source (migration 011): a clip draws from exactly
  // one source — a YouTube video (videoId, set for game highlights) or
  // an imported Drive video (importedVideoId). playerTag is a label
  // only (used for overlays on imported clips) — never a stat.
  if (
    c.importedVideoId !== undefined &&
    c.importedVideoId !== null &&
    typeof c.importedVideoId !== 'string'
  ) {
    return null;
  }
  if (
    c.playerTag !== undefined &&
    c.playerTag !== null &&
    (typeof c.playerTag !== 'string' || c.playerTag.length > 100)
  ) {
    return null;
  }
  return {
    eventId: typeof c.eventId === 'string' ? c.eventId : null,
    gameId: typeof c.gameId === 'string' ? c.gameId : null,
    videoId: typeof c.videoId === 'string' ? c.videoId : null,
    importedVideoId: typeof c.importedVideoId === 'string' ? c.importedVideoId : null,
    playerTag: typeof c.playerTag === 'string' ? c.playerTag : null,
    startSeconds: start,
    endSeconds: end,
    transition: c.transition,
    overlay: c.overlay,
    slowMo: c.slowMo,
  };
}

function cleanReelClips(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > REEL_CLIP_MAX) return null;
  const cleaned: Record<string, unknown>[] = [];
  for (const item of value) {
    const clip = cleanReelClip(item);
    if (!clip) return null;
    cleaned.push(clip);
  }
  return cleaned;
}

async function getOrgReel(db: ReturnType<typeof getPool>, req: express.Request, reelId: string) {
  const auth = authOf(req);
  const teamIds = auth.teamIds;
  // Non-owners see only reels tied to one of their teams' games. Reels
  // with no game (org-wide) are owner-only: the LEFT JOIN gives them a
  // NULL team, which never matches ANY(...).
  const reel = await db.query(
    `SELECT r.* FROM reel_projects r LEFT JOIN games g ON g.id = r.game_id
     WHERE r.id = $1 AND r.org_id = $2${teamIds ? ' AND g.team_id = ANY($3)' : ''}`,
    teamIds ? [reelId, auth.user.org_id, teamIds] : [reelId, auth.user.org_id],
  );
  return reel.rows[0] ?? null;
}

app.get(
  '/api/reels',
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const result = await db.query(
      'SELECT * FROM reel_projects WHERE org_id = $1 ORDER BY created_at DESC',
      [org.id],
    );
    // Non-owners see only reels tied to one of their teams' games.
    // Org-wide reels (no game) are owner-only.
    let reels = result.rows;
    if (authOf(req).teamIds !== null) {
      const games = await db.query('SELECT id FROM games WHERE team_id = ANY($1)', [
        authOf(req).teamIds,
      ]);
      const visibleGameIds = new Set(games.rows.map((g) => g.id as string));
      reels = reels.filter((r) => r.game_id && visibleGameIds.has(r.game_id));
    }
    res.json({ ok: true, reels });
  }),
);

app.post(
  '/api/reels',
  requirePermission('reels'),
  asyncHandler(async (req, res) => {
    const { name, game_id, clips, music_track } = req.body ?? {};
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
      res.status(400).json({ ok: false, error: 'Reel name must be a non-empty string.' });
      return;
    }
    if (name !== undefined && name.trim().length > 100) {
      res.status(400).json({ ok: false, error: 'Reel name must be 100 characters or fewer.' });
      return;
    }
    let cleanClips: Record<string, unknown>[] = [];
    if (clips !== undefined) {
      const cleaned = cleanReelClips(clips);
      if (!cleaned) {
        res.status(400).json({ ok: false, error: 'clips must be an array of valid clips.' });
        return;
      }
      cleanClips = cleaned;
    }
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    // A reel attached to a game must be on a team the caller can see.
    // A reel with no game is org-wide — owner-only.
    if (typeof game_id === 'string' && game_id) {
      const game = await getOrgGame(db, req, game_id);
      if (!game) {
        res.status(404).json({ ok: false, error: 'Game not found.' });
        return;
      }
    } else if (authOf(req).teamIds !== null) {
      res.status(403).json({ ok: false, error: 'Reels must be attached to one of your teams.' });
      return;
    }
    const result = await db.query(
      `INSERT INTO reel_projects (org_id, game_id, name, clips, music_track)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [
        org.id,
        typeof game_id === 'string' ? game_id : null,
        name !== undefined ? name.trim() : 'Untitled reel',
        JSON.stringify(cleanClips),
        typeof music_track === 'string' ? music_track : '',
      ],
    );
    res.status(201).json({ ok: true, reel: result.rows[0] });
  }),
);

// Auto Reel: one-tap draft from a game's scoring highlights, best-first
// (Kills/Aces/Blocks first, then Assists/Digs). The draft opens in Reel
// Studio for tweaking — nothing here is final until the coach saves it.
app.post(
  '/api/reels/auto',
  requirePermission('reels'),
  asyncHandler(async (req, res) => {
    const { gameId, preset } = req.body ?? {};
    if (typeof gameId !== 'string' || !gameId) {
      res.status(400).json({ ok: false, error: 'gameId is required.' });
      return;
    }
    const presetName: AutoPresetName =
      preset === 'hype' || preset === 'clean' || preset === 'simple' ? preset : 'hype';
    const presetConfig = AUTO_PRESETS[presetName];
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const game = await getOrgGame(db, req, gameId);
    if (!game) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    const team = await db.query('SELECT name FROM teams WHERE id = $1', [game.team_id]);
    const events = await db.query(
      `SELECT e.id, e.stat_type, e.video_seconds, p.name AS player_name
       FROM game_events e
       LEFT JOIN players p ON p.id = e.player_id
       WHERE e.game_id = $1 AND e.player_id IS NOT NULL
         AND e.stat_type IN ('Kill', 'Ace', 'Block', 'Assist', 'Dig')
       ORDER BY e.created_at ASC`,
      [gameId],
    );
    // Best-first: scoring plays (Kill/Ace/Block) before setup plays
    // (Assist/Dig), stable within each group by event order.
    const rank: Record<string, number> = { Kill: 0, Ace: 0, Block: 0, Assist: 1, Dig: 1 };
    const sorted = [...events.rows].sort(
      (a, b) => (rank[a.stat_type] ?? 2) - (rank[b.stat_type] ?? 2),
    );
    const clips = sorted.map((e) => ({
      eventId: e.id,
      gameId,
      videoId: game.youtube_video_id ?? null,
      startSeconds: Math.max(0, Number(e.video_seconds) - 2),
      endSeconds: Number(e.video_seconds) + 8,
      transition: presetConfig.transition,
      overlay: presetConfig.overlays ? `${e.player_name ?? 'Player'} — ${e.stat_type}` : '',
      slowMo: false,
    }));
    const name = `Auto reel — ${team.rows[0]?.name ?? 'Team'} vs ${game.opponent || 'TBD'}`;
    const result = await db.query(
      `INSERT INTO reel_projects (org_id, game_id, name, clips, music_track, status)
       VALUES ($1, $2, $3, $4, $5, 'draft') RETURNING *`,
      [org.id, gameId, name, JSON.stringify(clips), presetConfig.music],
    );
    res.status(201).json({ ok: true, reel: result.rows[0] });
  }),
);

app.get(
  '/api/reels/:id',
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const reel = await getOrgReel(db, req, String(req.params.id));
    if (!reel) {
      res.status(404).json({ ok: false, error: 'Reel not found.' });
      return;
    }
    res.json({ ok: true, reel });
  }),
);

app.patch(
  '/api/reels/:id',
  requirePermission('reels'),
  asyncHandler(async (req, res) => {
    const { name, clips, music_track, status } = req.body ?? {};
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const reelId = String(req.params.id);
    const reel = await getOrgReel(db, req, reelId);
    if (!reel) {
      res.status(404).json({ ok: false, error: 'Reel not found.' });
      return;
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
        res.status(400).json({ ok: false, error: 'Reel name must be a non-empty string of 100 characters or fewer.' });
        return;
      }
      values.push(name.trim());
      sets.push(`name = $${values.length}`);
    }
    if (clips !== undefined) {
      const cleaned = cleanReelClips(clips);
      if (!cleaned) {
        res.status(400).json({ ok: false, error: 'clips must be an array of valid clips.' });
        return;
      }
      values.push(JSON.stringify(cleaned));
      sets.push(`clips = $${values.length}`);
    }
    if (music_track !== undefined) {
      if (typeof music_track !== 'string') {
        res.status(400).json({ ok: false, error: 'music_track must be a string.' });
        return;
      }
      values.push(music_track);
      sets.push(`music_track = $${values.length}`);
    }
    if (status !== undefined) {
      if (status !== 'draft' && status !== 'ready') {
        res.status(400).json({ ok: false, error: "status must be 'draft' or 'ready'." });
        return;
      }
      values.push(status);
      sets.push(`status = $${values.length}`);
    }
    if (sets.length === 0) {
      res.json({ ok: true, reel });
      return;
    }
    values.push(reelId);
    const result = await db.query(
      `UPDATE reel_projects SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
      values,
    );
    res.json({ ok: true, reel: result.rows[0] });
  }),
);

app.delete(
  '/api/reels/:id',
  requirePermission('reels'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const reelId = String(req.params.id);
    const reel = await getOrgReel(db, req, reelId);
    if (!reel) {
      res.status(404).json({ ok: false, error: 'Reel not found.' });
      return;
    }
    await db.query('DELETE FROM reel_projects WHERE id = $1', [reelId]);
    res.json({ ok: true, deleted: true });
  }),
);

// Mock export: honest placeholder. There is no real MP4 rendering in this
// build — the export endpoint says so plainly instead of pretending.
app.post(
  '/api/reels/:id/export',
  requirePermission('reels'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const reel = await getOrgReel(db, req, String(req.params.id));
    if (!reel) {
      res.status(404).json({ ok: false, error: 'Reel not found.' });
      return;
    }
    res.json({
      ok: true,
      export: {
        status: 'mock',
        message:
          'This is a placeholder export, not a real video file. Real MP4 rendering comes in a later production build — your reel project (clips, order, trim, overlays, music) is saved and ready for it.',
      },
    });
  }),
);

// ---------------------------------------------------- family SMS (Twilio)
// Families SELF-ENROLL their own numbers via an unlisted enroll link
// per player — the coach never types in anyone's number. Coach views
// show MASKED numbers only (•••-•••-1234); full numbers never appear in
// any API response, public or coach-side. The watch link goes out THE
// MOMENT the coach taps Go Live (see the status-transition hook above),
// never 30 minutes before. Real sending uses Twilio; with no Twilio
// credentials configured the app runs in LOG-ONLY mode — every attempt
// is recorded as 'logged' and nothing claims it was sent.

const PUBLIC_ORIGIN = process.env.PUBLIC_URL ?? 'https://simpligame.onrender.com';

function maskPhone(phoneE164: string | null): string | null {
  if (!phoneE164) return null;
  const last4 = phoneE164.replace(/\D/g, '').slice(-4);
  return `•••-•••-${last4}`;
}

// Normalize a phone number to E.164. Accepts 10-digit US numbers,
// 11-digit numbers starting with 1, or a leading + already present.
// Anything else is rejected (400) — never stored half-normalized.
function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (hasPlus) {
    if (digits.length < 10 || digits.length > 15) return null;
    return `+${digits}`;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

type SmsMessageType = 'go_live' | 'highlights';

async function sendGameSms(
  db: ReturnType<typeof getPool>,
  game: {
    id: string;
    team_id: string;
    opponent: string;
    publish_token: string | null;
    published: boolean;
  },
  type: SmsMessageType,
): Promise<{ attempted: number; sent: number; logged: number; failed: number }> {
  const summary = { attempted: 0, sent: 0, logged: 0, failed: 0 };
  if (!game.published || !game.publish_token) return summary;
  const team = await db.query('SELECT name FROM teams WHERE id = $1', [game.team_id]);
  const teamName = team.rows[0]?.name ?? 'Your team';
  const link = `${PUBLIC_ORIGIN}/watch/${game.publish_token}`;
  const body =
    type === 'go_live'
      ? `${teamName} vs ${game.opponent || 'TBD'} is live! Watch: ${link}`
      : `${teamName} vs ${game.opponent || 'TBD'} — highlights are ready! Watch: ${link}`;
  const contacts = await db.query(
    `SELECT fc.id, fc.phone_e164 FROM family_contacts fc
     JOIN players p ON p.id = fc.player_id
     WHERE p.team_id = $1 AND fc.opted_in = true`,
    [game.team_id],
  );
  // One message per unique number: a family enrolled for two players on
  // the same team gets one text, not two.
  const seen = new Map<string, string>();
  for (const c of contacts.rows) {
    if (!seen.has(c.phone_e164)) seen.set(c.phone_e164, c.id);
  }
  for (const [phone, contactId] of seen) {
    summary.attempted += 1;
    const result = await sendSms(phone, body);
    let status: 'sent' | 'logged' | 'failed';
    let providerSid: string | null = null;
    let error: string | null = null;
    if (result.mode === 'sent') {
      status = 'sent';
      providerSid = result.sid;
      summary.sent += 1;
    } else if (result.mode === 'logged') {
      status = 'logged';
      summary.logged += 1;
    } else {
      status = 'failed';
      error = result.error;
      summary.failed += 1;
    }
    await db.query(
      `INSERT INTO sms_log (game_id, contact_id, message_type, status, provider_sid, error)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [game.id, contactId, type, status, providerSid, error],
    );
  }
  return summary;
}

// Coach: generate (or regenerate) a player's enrollment link. Regenerating
// kills the old link — same token model as watch/profile links.
app.post(
  '/api/players/:playerId/enroll-token',
  requirePermission('enroll'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const playerId = String(req.params.playerId);
    const player = await getOrgPlayer(db, req, playerId);
    if (!player) {
      res.status(404).json({ ok: false, error: 'Player not found.' });
      return;
    }
    const token = newPublishToken();
    const result = await db.query('UPDATE players SET enroll_token = $1 WHERE id = $2 RETURNING *', [
      token,
      playerId,
    ]);
    res.json({ ok: true, player: result.rows[0], enrollToken: token, publicPath: `/enroll/${token}` });
  }),
);

// Public enroll page (no auth): ONLY the player's first name + team
// name. No contacts, no numbers, no org details. A bad token gets the
// same generic 404 as every other token-only route.
app.get(
  '/api/public/enroll/:token',
  asyncHandler(async (req, res) => {
    const db = getPool();
    const row = await db.query(
      `SELECT p.name, t.name AS team_name
       FROM players p JOIN teams t ON t.id = p.team_id
       WHERE p.enroll_token = $1`,
      [req.params.token],
    );
    if (row.rows.length === 0) {
      res.status(404).json({ ok: false, error: 'Enrollment link not found.' });
      return;
    }
    const firstName = row.rows[0].name.split(/\s+/)[0] ?? row.rows[0].name;
    res.json({ ok: true, enroll: { player_first_name: firstName, team_name: row.rows[0].team_name } });
  }),
);

// Public enroll submit (no auth): the family enters their OWN number.
// Upserts on (player_id, phone_e164) — re-enrolling updates the name /
// opt-in flag instead of duplicating. The response carries only the
// MASKED number — the full number is never echoed back.
app.post(
  '/api/public/enroll/:token',
  asyncHandler(async (req, res) => {
    const { phone, displayName, optIn } = req.body ?? {};
    const e164 = normalizePhone(phone);
    if (!e164) {
      res.status(400).json({
        ok: false,
        error: 'Enter a valid phone number (10-digit US number, or +1 followed by 10 digits).',
      });
      return;
    }
    if (displayName !== undefined && (typeof displayName !== 'string' || displayName.trim().length > 100)) {
      res.status(400).json({ ok: false, error: 'Name must be 100 characters or fewer.' });
      return;
    }
    if (optIn !== undefined && typeof optIn !== 'boolean') {
      res.status(400).json({ ok: false, error: 'optIn must be true or false.' });
      return;
    }
    const optedIn = optIn === undefined ? true : optIn;
    const db = getPool();
    const row = await db.query('SELECT id FROM players WHERE enroll_token = $1', [req.params.token]);
    if (row.rows.length === 0) {
      res.status(404).json({ ok: false, error: 'Enrollment link not found.' });
      return;
    }
    await db.query(
      `INSERT INTO family_contacts (player_id, phone_e164, display_name, opted_in)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (player_id, phone_e164) DO UPDATE
       SET display_name = EXCLUDED.display_name, opted_in = EXCLUDED.opted_in, updated_at = now()`,
      [row.rows[0].id, e164, typeof displayName === 'string' ? displayName.trim() : '', optedIn],
    );
    res.json({ ok: true, opted_in: optedIn, masked_phone: maskPhone(e164) });
  }),
);

// Coach: a player's enrolled family — MASKED numbers only.
app.get(
  '/api/players/:playerId/family',
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const playerId = String(req.params.playerId);
    const player = await getOrgPlayer(db, req, playerId);
    if (!player) {
      res.status(404).json({ ok: false, error: 'Player not found.' });
      return;
    }
    const rows = await db.query(
      'SELECT * FROM family_contacts WHERE player_id = $1 ORDER BY created_at ASC',
      [playerId],
    );
    res.json({
      ok: true,
      contacts: rows.rows.map((c) => ({
        id: c.id,
        player_id: c.player_id,
        masked_phone: maskPhone(c.phone_e164),
        display_name: c.display_name,
        opted_in: c.opted_in,
        created_at: c.created_at,
      })),
    });
  }),
);

// Coach: remove an enrolled contact. Org-scoped via the join — a contact
// from another org 404s instead of leaking.
app.delete(
  '/api/family/:contactId',
  requirePermission('family_manage'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const teamRow = await db.query(
      `SELECT t.id AS team_id FROM family_contacts fc
       JOIN players p ON p.id = fc.player_id
       JOIN teams t ON t.id = p.team_id
       WHERE fc.id = $1 AND t.org_id = $2`,
      [String(req.params.contactId), org.id],
    );
    if (teamRow.rows.length === 0 || !canAccessTeam(authOf(req), teamRow.rows[0].team_id)) {
      res.status(404).json({ ok: false, error: 'Contact not found.' });
      return;
    }
    await db.query('DELETE FROM family_contacts WHERE id = $1', [String(req.params.contactId)]);
    res.json({ ok: true, deleted: true });
  }),
);

// Coach: a game's SMS delivery log — MASKED numbers only. Contacts
// deleted after sending show as "Removed contact" (masked_phone null)
// rather than leaking the number from a stale join.
app.get(
  '/api/games/:gameId/sms-log',
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const gameId = String(req.params.gameId);
    const game = await getOrgGame(db, req, gameId);
    if (!game) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    const rows = await db.query(
      `SELECT sl.*, fc.phone_e164 FROM sms_log sl
       LEFT JOIN family_contacts fc ON fc.id = sl.contact_id
       WHERE sl.game_id = $1 ORDER BY sl.created_at DESC`,
      [gameId],
    );
    res.json({
      ok: true,
      log: rows.rows.map((r) => ({
        id: r.id,
        game_id: r.game_id,
        message_type: r.message_type,
        status: r.status,
        provider_sid: r.provider_sid,
        error: r.error,
        created_at: r.created_at,
        masked_phone: maskPhone(r.phone_e164 ?? null),
      })),
    });
  }),
);

// Coach: highlights-ready alerts. Requires a published game — the alert
// carries the watch link, and an unpublished game has no link to send.
app.post(
  '/api/games/:gameId/notify-highlights',
  requirePermission('family_notify'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const gameId = String(req.params.gameId);
    const game = await getOrgGame(db, req, gameId);
    if (!game) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    if (!game.published || !game.publish_token) {
      res.status(400).json({
        ok: false,
        error: 'Publish this game first — highlights alerts need a watch link to send.',
      });
      return;
    }
    const summary = await sendGameSms(db, game, 'highlights');
    res.json({ ok: true, ...summary });
  }),
);

// ------------------------------------------- Google Sheets export
// Build a real Sheet from the game's own events + box score (same
// aggregation as the public watch box score — no invented stats).
// Service-account auth — no per-coach OAuth in this round. With no
// Google credentials configured the endpoint returns
// { notConfigured: true } — no HTTP call, no fake URL, never pretending
// it worked. The coach can always use Download CSV (client-side) as the
// always-available fallback. Export rows are recorded in
// sheet_exports so Game Detail lists past exports with links.
function formatSheetTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

app.post(
  '/api/games/:gameId/export-sheets',
  requirePermission('export'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const gameId = String(req.params.gameId);
    const game = await getOrgGame(db, req, gameId);
    if (!game) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    if (!isSheetsConfigured()) {
      res.json({ ok: true, notConfigured: true });
      return;
    }
    const team = await db.query('SELECT name FROM teams WHERE id = $1', [game.team_id]);
    const teamName = team.rows[0]?.name ?? 'Team';
    const players = await db.query('SELECT id, name, jersey_number FROM players WHERE team_id = $1', [
      game.team_id,
    ]);
    const byId = new Map(players.rows.map((p) => [p.id, p]));
    const events = await db.query(
      `SELECT * FROM game_events WHERE game_id = $1 ORDER BY created_at ASC, id ASC`,
      [gameId],
    );
    // Box Score tab: Player, Jersey, Points, then one column per stat
    // type actually present in this game (sorted for stable columns).
    const statTypes = [...new Set(events.rows.map((e) => e.stat_type as string))].sort();
    const boxHeaders = ['Player', 'Jersey', 'Points', ...statTypes];
    const boxByPlayer = new Map<string, { name: string; jersey: string; points: number; stats: Record<string, number> }>();
    const timelineRows: (string | number)[][] = [];
    for (const e of events.rows) {
      const player = e.player_id ? byId.get(e.player_id) : null;
      const name = player?.name ?? (e.side === 'opponent' ? 'Opponent' : 'Team');
      let entry = e.player_id ? boxByPlayer.get(e.player_id) : undefined;
      if (e.player_id && !entry) {
        entry = { name, jersey: player?.jersey_number ?? '', points: 0, stats: {} };
        boxByPlayer.set(e.player_id, entry);
      }
      if (entry) {
        entry.stats[e.stat_type] = (entry.stats[e.stat_type] ?? 0) + 1;
        // Our-side points only — an opponent-side point (e.g. our Serve
        // Error) is the opponent's point, not this player's.
        if (e.side === 'ours') {
          entry.points += e.points;
        }
      }
      timelineRows.push([
        new Date(e.created_at).toLocaleString(),
        name,
        e.stat_type,
        e.side,
        e.points,
        formatSheetTimestamp(e.video_seconds),
      ]);
    }
    const boxRows = [...boxByPlayer.values()].map((entry) => [
      entry.name,
      entry.jersey,
      entry.points,
      ...statTypes.map((t) => entry.stats[t] ?? 0),
    ]);
    const rows: SheetRows = {
      boxScoreHeaders: boxHeaders,
      boxScoreRows: boxRows,
      timelineHeaders: ['Time', 'Player', 'Stat', 'Side', 'Points', 'Video'],
      timelineRows,
    };
    const date = new Date(game.created_at).toLocaleDateString();
    const title = `${teamName} vs ${game.opponent || 'TBD'} — ${date}`;
    const result = await exportGameToSheets(title, rows);
    if (result.mode === 'not_configured') {
      res.json({ ok: true, notConfigured: true });
      return;
    }
    if (result.mode === 'failed') {
      res.status(502).json({ ok: false, error: result.error });
      return;
    }
    const inserted = await db.query(
      `INSERT INTO sheet_exports (game_id, sheet_id, sheet_url)
       VALUES ($1, $2, $3) RETURNING *`,
      [gameId, result.sheetId, result.sheetUrl],
    );
    res.json({ ok: true, sheetId: result.sheetId, sheetUrl: result.sheetUrl, export: inserted.rows[0] });
  }),
);

app.get(
  '/api/games/:gameId/exports',
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const gameId = String(req.params.gameId);
    const game = await getOrgGame(db, req, gameId);
    if (!game) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    const rows = await db.query(
      'SELECT * FROM sheet_exports WHERE game_id = $1 ORDER BY created_at DESC',
      [gameId],
    );
    res.json({ ok: true, exports: rows.rows });
  }),
);

// All Sheets exports across the org's games, newest first — the
// Export Center's Past Exports list. Team-scoped for non-owners:
// coaches see only exports for their assigned teams' games.
app.get(
  '/api/exports',
  requirePermission('export'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const auth = authOf(req);
    const teamIds = auth.teamIds;
    const rows = await db.query(
      `SELECT se.*, g.opponent, g.status, g.our_score, g.opponent_score, t.name AS team_name
       FROM sheet_exports se
       JOIN games g ON g.id = se.game_id
       JOIN teams t ON t.id = g.team_id
       WHERE t.org_id = $1${teamIds ? ' AND t.id = ANY($2)' : ''}
       ORDER BY se.created_at DESC`,
      teamIds ? [auth.user.org_id, teamIds] : [auth.user.org_id],
    );
    res.json({ ok: true, exports: rows.rows });
  }),
);

// ------------------------------------------- Google Drive video import
// Imported videos live in each uploader's OWN Google Drive (drive.file
// scope — see drive.ts and migration 011). Parents (migration 012)
// import too, scoped to their linked players' teams — see the init
// handler. Upload flow: the server
// initiates a Drive resumable session with the uploader's access
// token, the browser PUTs the file straight to Google in chunks, then
// /complete verifies the file and marks the row ready. Playback uses
// short-lived media URLs minted with the VIDEO OWNER's access token
// (see the media-url handler) — any coach who can see the video in
// the library can play it, which is the point of the app record.
//
// If migration 011 has not run yet, every endpoint fails with the
// explicit run-the-migration message instead of a generic 500.

/** The library's public shape — never a token, never the raw
 *  drive_file_id (playback goes through the media-url endpoint). */
function publicImportedVideo(row: Record<string, unknown>, callerId: string) {
  return {
    id: row.id as string,
    title: row.title as string,
    team_id: (row.team_id as string | null) ?? null,
    mime_type: (row.mime_type as string) ?? '',
    size_bytes: Number(row.size_bytes ?? 0),
    ready: row.ready === true,
    owner_user_id: row.owner_user_id as string,
    mine: row.owner_user_id === callerId,
    created_at: row.created_at as string,
  };
}

/** Load a user's stored Drive refresh token. Returns null when the
 *  user never connected (or disconnected) Google Drive. */
async function loadDriveRefreshToken(
  db: ReturnType<typeof getPool>,
  userId: string,
): Promise<string | null> {
  const row = await db.query('SELECT google_refresh_token FROM users WHERE id = $1', [userId]);
  const token = row.rows[0]?.google_refresh_token as string | null | undefined;
  return typeof token === 'string' && token ? token : null;
}

/** A fresh Drive access token for a user, or null when they are not
 *  connected or Google refuses the grant. */
async function freshDriveAccessToken(
  db: ReturnType<typeof getPool>,
  userId: string,
): Promise<string | null> {
  const refreshToken = await loadDriveRefreshToken(db, userId);
  if (!refreshToken) return null;
  return refreshDriveAccessToken(refreshToken);
}

/** Visibility rule shared by the list and media-url: ready videos are
 *  visible to their owner, the org owner, and coaches assigned to the
 *  video's team; incomplete (not-ready) videos only to their owner. */
function canSeeImportedVideo(
  row: { ready: unknown; owner_user_id: unknown; team_id: unknown },
  auth: ReturnType<typeof authOf>,
): boolean {
  if (row.owner_user_id === auth.user.id) return true;
  if (row.ready !== true) return false;
  if (auth.teamIds === null) return true; // org owner
  return typeof row.team_id === 'string' && auth.teamIds.includes(row.team_id);
}

/** Gate for the import write endpoints: coaches need 'reels'
 *  (head_coach+); parents (migration 012) import too — the handlers
 *  scope a parent to the teams of their linked players and to their
 *  own uploads, so the permission gate alone is not the enforcement. */
function requireReelsOrParent(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const role = req.auth?.user.role;
  if (role === 'parent' || (role !== undefined && can(role, 'reels'))) {
    next();
    return;
  }
  res.status(403).json({ ok: false, error: 'Your role does not allow this action.' });
}

app.post(
  '/api/imported-videos/init',
  requireReelsOrParent,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const { title, team_id, mime_type, size_bytes } = req.body ?? {};
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 150) {
      res.status(400).json({ ok: false, error: 'A title of 150 characters or fewer is required.' });
      return;
    }
    if (typeof mime_type !== 'string' || !/^video\//.test(mime_type)) {
      res.status(400).json({ ok: false, error: 'Only video files can be imported.' });
      return;
    }
    const size = Number(size_bytes);
    if (!Number.isInteger(size) || size <= 0 || size > 10 * 1024 * 1024 * 1024) {
      res.status(400).json({ ok: false, error: 'File size must be between 1 byte and 10 GB.' });
      return;
    }
    if (!isDriveConfigured()) {
      res.status(503).json({
        ok: false,
        error: 'Google Drive is not configured on the server (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET).',
      });
      return;
    }
    const db = getPool();
    try {
      const org = await getOrCreateOrganization(auth.user.org_id);
      let teamId: string | null = null;
      if (typeof team_id === 'string' && team_id) {
        const team = await db.query('SELECT id FROM teams WHERE id = $1 AND org_id = $2', [
          team_id,
          org.id,
        ]);
        if (team.rows.length === 0) {
          res.status(404).json({ ok: false, error: 'Team not found.' });
          return;
        }
        if (auth.user.role === 'parent') {
          // Parents import ONLY for a team one of their linked
          // players plays on (migration 012) — anything else is the
          // same 404 as a team that doesn't exist.
          let linked: { rows: unknown[] };
          try {
            linked = await db.query(
              `SELECT 1 FROM parent_players pp JOIN players p ON p.id = pp.player_id
               WHERE pp.user_id = $1 AND p.team_id = $2 LIMIT 1`,
              [auth.user.id, team_id],
            );
          } catch (err) {
            if (isMissingParentSchema(err)) {
              res.status(503).json({ ok: false, error: PARENT_MIGRATION_MESSAGE });
              return;
            }
            throw err;
          }
          if (linked.rows.length === 0) {
            res.status(404).json({ ok: false, error: 'Team not found.' });
            return;
          }
        } else if (!canAccessTeam(auth, team_id)) {
          res.status(404).json({ ok: false, error: 'Team not found.' });
          return;
        }
        teamId = team_id;
      } else if (auth.user.role === 'parent') {
        // A parent's import always belongs to a linked player's team —
        // a team-less import would be invisible to the team's coaches.
        res.status(400).json({ ok: false, error: 'Choose the team this video belongs to.' });
        return;
      }
      const accessToken = await freshDriveAccessToken(db, auth.user.id);
      if (!accessToken) {
        res.status(400).json({
          ok: false,
          error: 'Connect Google Drive first (Account screen → Google Drive), then try again.',
        });
        return;
      }
      const folder = await findOrCreateSimpliGameFolder(accessToken);
      if (!folder.ok) {
        res.status(502).json({ ok: false, error: folder.error });
        return;
      }
      const inserted = await db.query(
        `INSERT INTO imported_videos (org_id, owner_user_id, title, team_id, mime_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [org.id, auth.user.id, title.trim(), teamId, mime_type, size],
      );
      const row = inserted.rows[0];
      const session = await initiateResumableUpload(accessToken, {
        folderId: folder.folderId,
        name: title.trim(),
        mimeType: mime_type,
        sizeBytes: size,
      });
      if (!session.ok) {
        // No session → nothing can ever upload against this row.
        await db.query('DELETE FROM imported_videos WHERE id = $1', [row.id]).catch(() => {});
        res.status(502).json({ ok: false, error: session.error });
        return;
      }
      res.status(201).json({ ok: true, videoId: row.id as string, uploadUrl: session.uploadUrl });
    } catch (err) {
      if (isMissingDriveSchema(err)) {
        res.status(503).json({ ok: false, error: DRIVE_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

app.post(
  '/api/imported-videos/:id/complete',
  requireReelsOrParent,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const db = getPool();
    try {
      const org = await getOrCreateOrganization(auth.user.org_id);
      const found = await db.query('SELECT * FROM imported_videos WHERE id = $1 AND org_id = $2', [
        String(req.params.id),
        org.id,
      ]);
      const row = found.rows[0];
      // Only the uploader completes their own upload.
      if (!row || row.owner_user_id !== auth.user.id) {
        res.status(404).json({ ok: false, error: 'Imported video not found.' });
        return;
      }
      if (row.ready === true) {
        res.json({ ok: true, video: publicImportedVideo(row, auth.user.id) });
        return;
      }
      const accessToken = await freshDriveAccessToken(db, auth.user.id);
      if (!accessToken) {
        res.status(400).json({
          ok: false,
          error: 'Your Google Drive connection needs to be reconnected (Account screen → Google Drive).',
        });
        return;
      }
      // The browser reports the file id from Drive's final upload
      // response; verify it server-side before trusting it. Fallback:
      // find the file by title inside the SimpliGame folder.
      const reportedId =
        typeof req.body?.drive_file_id === 'string' && req.body.drive_file_id
          ? (req.body.drive_file_id as string)
          : typeof row.drive_file_id === 'string'
            ? (row.drive_file_id as string)
            : null;
      let info = reportedId ? await getDriveFile(accessToken, reportedId) : null;
      if (!info || info.trashed) {
        const folder = await findOrCreateSimpliGameFolder(accessToken);
        info = folder.ok ? await findDriveFileInFolder(accessToken, folder.folderId, row.title as string) : null;
      }
      if (!info || info.trashed) {
        res.status(400).json({
          ok: false,
          error: 'The upload was not found in Drive yet — let the upload finish, then try again.',
        });
        return;
      }
      const updated = await db.query(
        'UPDATE imported_videos SET drive_file_id = $1, size_bytes = $2, ready = true WHERE id = $3 RETURNING *',
        [info.id, info.sizeBytes > 0 ? info.sizeBytes : row.size_bytes, row.id],
      );
      res.json({ ok: true, video: publicImportedVideo(updated.rows[0], auth.user.id) });
    } catch (err) {
      if (isMissingDriveSchema(err)) {
        res.status(503).json({ ok: false, error: DRIVE_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

app.get(
  '/api/imported-videos',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const db = getPool();
    try {
      const org = await getOrCreateOrganization(auth.user.org_id);
      const rows = await db.query(
        `SELECT * FROM imported_videos
         WHERE org_id = $1
           AND (
             owner_user_id = $2
             OR (ready = true AND ($3::uuid[] IS NULL OR team_id = ANY($3)))
           )
         ORDER BY created_at DESC`,
        [org.id, auth.user.id, auth.teamIds],
      );
      res.json({ ok: true, videos: rows.rows.map((r) => publicImportedVideo(r, auth.user.id)) });
    } catch (err) {
      if (isMissingDriveSchema(err)) {
        res.status(503).json({ ok: false, error: DRIVE_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

app.delete(
  '/api/imported-videos/:id',
  requireReelsOrParent,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const db = getPool();
    try {
      const org = await getOrCreateOrganization(auth.user.org_id);
      const found = await db.query('SELECT * FROM imported_videos WHERE id = $1 AND org_id = $2', [
        String(req.params.id),
        org.id,
      ]);
      const row = found.rows[0];
      // Only the uploader or the org owner can delete an import.
      if (!row || (row.owner_user_id !== auth.user.id && auth.user.role !== 'owner')) {
        res.status(404).json({ ok: false, error: 'Imported video not found.' });
        return;
      }
      if (typeof row.drive_file_id === 'string' && row.drive_file_id) {
        // Best-effort Drive delete with the OWNER's token (the file
        // lives in their Drive). If it fails — owner disconnected,
        // already deleted — the library row still goes; a stray file
        // in the owner's own Drive is theirs to remove.
        const ownerToken = await freshDriveAccessToken(db, row.owner_user_id as string).catch(
          () => null,
        );
        if (ownerToken) {
          const deleted = await deleteDriveFile(ownerToken, row.drive_file_id as string);
          if (!deleted) {
            console.error(`Drive delete failed for imported video ${row.id as string} (row deleted anyway).`);
          }
        }
      }
      await db.query('DELETE FROM imported_videos WHERE id = $1', [row.id]);
      res.json({ ok: true, deleted: true });
    } catch (err) {
      if (isMissingDriveSchema(err)) {
        res.status(503).json({ ok: false, error: DRIVE_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

app.get(
  '/api/imported-videos/:id/media-url',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const db = getPool();
    try {
      const org = await getOrCreateOrganization(auth.user.org_id);
      const found = await db.query('SELECT * FROM imported_videos WHERE id = $1 AND org_id = $2', [
        String(req.params.id),
        org.id,
      ]);
      const row = found.rows[0];
      if (!row || !canSeeImportedVideo(row, auth)) {
        res.status(404).json({ ok: false, error: 'Imported video not found.' });
        return;
      }
      if (typeof row.drive_file_id !== 'string' || !row.drive_file_id) {
        res.status(400).json({ ok: false, error: 'This import has no Drive file yet.' });
        return;
      }
      // HONEST NOTE: this URL carries the VIDEO OWNER's Drive access
      // token, not the caller's — an imported video plays for the
      // org's coaches through the app record, by design (the owner
      // imported it for the team). The token is short-lived (~1 hour),
      // scoped to drive.file (only files SimpliGame created in the
      // owner's Drive), and the URL is minted fresh per request for a
      // signed-in coach who can already see the video in the library.
      // Drive supports Range requests on media downloads, so the
      // <video> element can seek for clip cutting.
      const ownerToken = await freshDriveAccessToken(db, row.owner_user_id as string);
      if (!ownerToken) {
        res.status(400).json({
          ok: false,
          error: 'The video owner has disconnected Google Drive — this import cannot play right now.',
        });
        return;
      }
      res.json({
        ok: true,
        url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(row.drive_file_id as string)}?alt=media&access_token=${encodeURIComponent(ownerToken)}`,
        expiresInSeconds: 3600,
      });
    } catch (err) {
      if (isMissingDriveSchema(err)) {
        res.status(503).json({ ok: false, error: DRIVE_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

// ------------------------------------------- assisted post-game analysis
// Rule-based overview + human sign-off. The overview is recomputed from
// the game's real events on every read (never stored, never AI, never
// invented); only the coach's per-section review state persists in
// game_analysis. Overall status: unreviewed / partially verified /
// verified. Only Verified sections count as official.
//
// If migration 008 has not run yet, GET still returns the overview
// (with no review state) instead of 500ing; POSTs fail with an
// explicit run-the-migration message.
async function loadStoredReview(db: ReturnType<typeof getPool>, gameId: string) {
  try {
    const row = await db.query('SELECT sections FROM game_analysis WHERE game_id = $1', [gameId]);
    return (row.rows[0]?.sections ?? {}) as Record<string, StoredSectionReview>;
  } catch (err) {
    // Table missing (migration 008 not run yet) → no review state.
    if ((err as { code?: string }).code === '42P01') return {};
    throw err;
  }
}

function isMissingAnalysisTable(err: unknown): boolean {
  return (err as { code?: string }).code === '42P01';
}

app.get(
  '/api/games/:gameId/analysis',
  asyncHandler(async (req, res) => {
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const gameId = String(req.params.gameId);
    const game = await getOrgGame(db, req, gameId);
    if (!game) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    const [events, players] = await Promise.all([
      db.query('SELECT * FROM game_events WHERE game_id = $1 ORDER BY created_at ASC, id ASC', [gameId]),
      db.query('SELECT id, name, jersey_number FROM players WHERE team_id = $1', [game.team_id]),
    ]);
    const overview = generateOverview({
      game: {
        status: game.status,
        our_score: game.our_score,
        opponent_score: game.opponent_score,
        youtube_video_id: game.youtube_video_id,
      },
      events: events.rows,
      players: players.rows,
    });
    const stored = await loadStoredReview(db, gameId);
    const sections = applyReview(overview, stored);
    res.json({ ok: true, game_id: gameId, overall_status: deriveOverallStatus(sections), sections });
  }),
);

app.post(
  '/api/games/:gameId/analysis/sections/:key/verify',
  requirePermission('analysis_review'),
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    if (!isAnalysisSectionKey(key)) {
      res.status(400).json({ ok: false, error: 'Unknown analysis section.' });
      return;
    }
    const { correction, note } = req.body ?? {};
    for (const [field, value] of Object.entries({ correction, note })) {
      if (value !== undefined && (typeof value !== 'string' || value.length > 500)) {
        res.status(400).json({ ok: false, error: `${field} must be a string of 500 characters or fewer.` });
        return;
      }
    }
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const gameId = String(req.params.gameId);
    const game = await getOrgGame(db, req, gameId);
    if (!game) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    try {
      const stored = await loadStoredReview(db, gameId);
      stored[key] = {
        verified: true,
        correction: typeof correction === 'string' && correction.trim() ? correction.trim() : null,
        note: typeof note === 'string' && note.trim() ? note.trim() : null,
        verified_at: new Date().toISOString(),
      };
      // Recompute overall from the merged sections so the stored status
      // always matches the review state.
      const events = await db.query('SELECT * FROM game_events WHERE game_id = $1 ORDER BY created_at ASC, id ASC', [
        gameId,
      ]);
      const players = await db.query('SELECT id, name, jersey_number FROM players WHERE team_id = $1', [
        game.team_id,
      ]);
      const sections = applyReview(
        generateOverview({
          game: {
            status: game.status,
            our_score: game.our_score,
            opponent_score: game.opponent_score,
            youtube_video_id: game.youtube_video_id,
          },
          events: events.rows,
          players: players.rows,
        }),
        stored,
      );
      const overall = deriveOverallStatus(sections);
      await db.query(
        `INSERT INTO game_analysis (game_id, sections, overall_status, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (game_id) DO UPDATE
         SET sections = EXCLUDED.sections, overall_status = EXCLUDED.overall_status, updated_at = now()`,
        [gameId, JSON.stringify(stored), overall],
      );
      res.json({ ok: true, game_id: gameId, overall_status: overall, sections });
    } catch (err) {
      if (isMissingAnalysisTable(err)) {
        res.status(500).json({
          ok: false,
          error: 'Analysis table is missing — run migrations/008_game_analysis.sql in the Neon SQL Editor, then restart.',
        });
        return;
      }
      throw err;
    }
  }),
);

app.post(
  '/api/games/:gameId/analysis/sections/:key/unverify',
  requirePermission('analysis_review'),
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    if (!isAnalysisSectionKey(key)) {
      res.status(400).json({ ok: false, error: 'Unknown analysis section.' });
      return;
    }
    const db = getPool();
    const org = await getOrCreateOrganization(req.auth!.user.org_id);
    const gameId = String(req.params.gameId);
    const game = await getOrgGame(db, req, gameId);
    if (!game) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    try {
      const stored = await loadStoredReview(db, gameId);
      const existing = stored[key];
      // Back to pending. The correction/note are kept as the review
      // history for this section — only the verified flag clears.
      stored[key] = {
        verified: false,
        correction: existing?.correction ?? null,
        note: existing?.note ?? null,
        verified_at: null,
      };
      const events = await db.query('SELECT * FROM game_events WHERE game_id = $1 ORDER BY created_at ASC, id ASC', [
        gameId,
      ]);
      const players = await db.query('SELECT id, name, jersey_number FROM players WHERE team_id = $1', [
        game.team_id,
      ]);
      const sections = applyReview(
        generateOverview({
          game: {
            status: game.status,
            our_score: game.our_score,
            opponent_score: game.opponent_score,
            youtube_video_id: game.youtube_video_id,
          },
          events: events.rows,
          players: players.rows,
        }),
        stored,
      );
      const overall = deriveOverallStatus(sections);
      await db.query(
        `INSERT INTO game_analysis (game_id, sections, overall_status, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (game_id) DO UPDATE
         SET sections = EXCLUDED.sections, overall_status = EXCLUDED.overall_status, updated_at = now()`,
        [gameId, JSON.stringify(stored), overall],
      );
      res.json({ ok: true, game_id: gameId, overall_status: overall, sections });
    } catch (err) {
      if (isMissingAnalysisTable(err)) {
        res.status(500).json({
          ok: false,
          error: 'Analysis table is missing — run migrations/008_game_analysis.sql in the Neon SQL Editor, then restart.',
        });
        return;
      }
      throw err;
    }
  }),
);

// ------------------------------------------- AI Vision Phase 1: AI Review Queue
// Post-game ONLY, human-in-the-loop. The coach's own machine (the
// local worker, worker/analyze.py) polls for pending jobs, downloads
// the game's video itself, runs the local model (our own weights,
// trained on our own footage), and POSTs candidate events back. The
// server stores jobs + candidates and serves the Review Queue. NO
// inference runs on the server (Render has no GPU) and footage is
// never uploaded anywhere — the worker processes it locally and
// deletes it.
//
// Worker auth: the shared WORKER_KEY env var, sent as X-Worker-Key.
// The key is never logged. If WORKER_KEY is unset, worker routes 503.
//
// Coach routes use the existing 'reels' permission (head_coach+) —
// analysis is the same tier as exports/reels, per the matrix.
// If migration 010 has not run yet, endpoints fail with an explicit
// run-the-migration message.
const AI_ANALYSIS_MIGRATION_MESSAGE =
  'AI analysis is not set up yet — run migrations/010_ai_analysis.sql in the Neon SQL Editor, then restart.';

function isMissingAiAnalysisTable(err: unknown): boolean {
  return (err as { code?: string }).code === '42P01';
}

/** Worker-key check: timing-safe compare, never logs the key. */
function workerKeyOk(req: express.Request): boolean {
  const configured = process.env.WORKER_KEY;
  if (!configured) return false;
  const presented = req.headers['x-worker-key'];
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(configured);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireWorkerKey(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!process.env.WORKER_KEY) {
    res.status(503).json({ ok: false, error: 'Worker key is not configured — set WORKER_KEY in Render and restart.' });
    return;
  }
  if (!workerKeyOk(req)) {
    res.status(401).json({ ok: false, error: 'Invalid worker key.' });
    return;
  }
  next();
}

/** Map a stat label to the side/points the event pipeline expects.
//  Mirrors the client stat buttons (VOLLEYBALL_STAT_BUTTONS): scoring
//  stats carry their point; everything else records with no score. */
function aiStatToSidePoints(stat: string): { side: 'ours' | 'opponent'; points: number } {
  switch (stat) {
    case 'Kill':
    case 'Ace':
    case 'Block':
      return { side: 'ours', points: 1 };
    case 'Serve Error':
    case 'Passing Error':
      return { side: 'opponent', points: 1 };
    default:
      return { side: 'ours', points: 0 };
  }
}

const VALID_AI_STATS = new Set([
  'Kill', 'Ace', 'Block', 'Assist', 'Dig', 'Attack Attempt',
  'Serve Error', 'Passing Error', 'Serve', 'Error', 'Attack attempt',
]);

// Create a pending job for a finished game. One active job per game —
// if one is already pending/processing, return it instead of duping.
app.post(
  '/api/games/:gameId/analysis-job',
  requirePermission('reels'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const gameId = String(req.params.gameId);
    const game = await getOrgGame(db, req, gameId);
    if (!game) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    if (game.status !== 'final') {
      res.status(400).json({ ok: false, error: 'AI analysis runs on finished games only — end the game first.' });
      return;
    }
    if (!game.youtube_video_id) {
      res.status(400).json({ ok: false, error: 'Attach a video first — the worker needs a video to analyze.' });
      return;
    }
    try {
      const existing = await db.query(
        `SELECT * FROM analysis_jobs WHERE game_id = $1 AND status IN ('pending', 'processing')
         ORDER BY created_at DESC LIMIT 1`,
        [gameId],
      );
      if (existing.rows.length > 0) {
        res.json({ ok: true, job: existing.rows[0], existed: true });
        return;
      }
      const created = await db.query(
        `INSERT INTO analysis_jobs (game_id, status) VALUES ($1, 'pending') RETURNING *`,
        [gameId],
      );
      res.status(201).json({ ok: true, job: created.rows[0], existed: false });
    } catch (err) {
      if (isMissingAiAnalysisTable(err)) {
        res.status(503).json({ ok: false, error: AI_ANALYSIS_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

// Latest job + its candidates for one game (coach view).
app.get(
  '/api/games/:gameId/analysis-job',
  requirePermission('reels'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const gameId = String(req.params.gameId);
    const game = await getOrgGame(db, req, gameId);
    if (!game) {
      res.status(404).json({ ok: false, error: 'Game not found.' });
      return;
    }
    try {
      const job = await db.query(
        `SELECT * FROM analysis_jobs WHERE game_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [gameId],
      );
      if (job.rows.length === 0) {
        res.json({ ok: true, job: null, candidates: [] });
        return;
      }
      const candidates = await db.query(
        `SELECT * FROM analysis_candidates WHERE job_id = $1 ORDER BY timestamp_sec ASC`,
        [job.rows[0].id],
      );
      res.json({ ok: true, job: job.rows[0], candidates: candidates.rows });
    } catch (err) {
      if (isMissingAiAnalysisTable(err)) {
        res.status(503).json({ ok: false, error: AI_ANALYSIS_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

// All jobs for the coach's org (drives the per-game status in the
// Live tab Final list). Head_coach+; non-owners see only their teams.
app.get(
  '/api/analysis/jobs',
  requirePermission('reels'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const auth = authOf(req);
    try {
      const jobs = await db.query(
        `SELECT j.* FROM analysis_jobs j
         JOIN games g ON g.id = j.game_id JOIN teams t ON t.id = g.team_id
         WHERE t.org_id = $1${auth.teamIds ? ' AND t.id = ANY($2)' : ''}
         ORDER BY j.created_at DESC`,
        auth.teamIds ? [auth.user.org_id, auth.teamIds] : [auth.user.org_id],
      );
      res.json({ ok: true, jobs: jobs.rows });
    } catch (err) {
      if (isMissingAiAnalysisTable(err)) {
        res.status(503).json({ ok: false, error: AI_ANALYSIS_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

// Worker: list pending jobs with the video to download. The worker
// polls this — nothing ever connects inbound to the owner's machine.
app.get(
  '/api/analysis/jobs/pending',
  requireWorkerKey,
  asyncHandler(async (_req, res) => {
    const db = getPool();
    try {
      const jobs = await db.query(
        `SELECT j.id, j.game_id, g.youtube_video_id
         FROM analysis_jobs j JOIN games g ON g.id = j.game_id
         WHERE j.status = 'pending' ORDER BY j.created_at ASC`,
      );
      res.json({ ok: true, jobs: jobs.rows });
    } catch (err) {
      if (isMissingAiAnalysisTable(err)) {
        res.status(503).json({ ok: false, error: AI_ANALYSIS_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

// Worker: post candidates for a job. Sets the job to done (or failed
// with an error message, so the queue shows what went wrong instead
// of hanging on "Processing" forever).
app.post(
  '/api/analysis/jobs/:jobId/results',
  requireWorkerKey,
  asyncHandler(async (req, res) => {
    const db = getPool();
    const jobId = String(req.params.jobId);
    const { candidates, status, error } = req.body ?? {};
    try {
      const job = await db.query('SELECT * FROM analysis_jobs WHERE id = $1', [jobId]);
      if (job.rows.length === 0) {
        res.status(404).json({ ok: false, error: 'Job not found.' });
        return;
      }
      if (status === 'failed') {
        await db.query(
          `UPDATE analysis_jobs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
          [jobId, typeof error === 'string' ? error.slice(0, 500) : 'Worker failed.'],
        );
        res.json({ ok: true, job: { ...job.rows[0], status: 'failed' } });
        return;
      }
      if (!Array.isArray(candidates)) {
        res.status(400).json({ ok: false, error: 'candidates must be an array.' });
        return;
      }
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        // Re-posting results for the same job replaces the old
        // candidates — the worker is the single writer per job.
        await client.query('DELETE FROM analysis_candidates WHERE job_id = $1', [jobId]);
        for (const c of candidates) {
          const ts = Number(c?.timestamp_sec);
          const start = Number(c?.clip_start_sec ?? Math.max(0, ts - 3));
          const end = Number(c?.clip_end_sec ?? ts + 3);
          const conf = Number(c?.confidence ?? 0);
          if (!Number.isFinite(ts) || ts < 0) continue;
          if (typeof c?.proposed_stat !== 'string' || !c.proposed_stat.trim()) continue;
          await client.query(
            `INSERT INTO analysis_candidates
             (job_id, game_id, timestamp_sec, clip_start_sec, clip_end_sec, proposed_stat, proposed_player_id, confidence)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              jobId,
              job.rows[0].game_id,
              ts,
              Number.isFinite(start) ? Math.max(0, start) : Math.max(0, ts - 3),
              Number.isFinite(end) ? Math.max(end, ts) : ts + 3,
              c.proposed_stat.trim().slice(0, 100),
              typeof c?.proposed_player_id === 'string' ? c.proposed_player_id : null,
              Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0,
            ],
          );
        }
        await client.query(
          `UPDATE analysis_jobs SET status = 'done', error = NULL, updated_at = now() WHERE id = $1`,
          [jobId],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      res.json({ ok: true, job: { ...job.rows[0], status: 'done' }, candidateCount: candidates.length });
    } catch (err) {
      if (isMissingAiAnalysisTable(err)) {
        res.status(503).json({ ok: false, error: AI_ANALYSIS_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

// Confirm a candidate: writes a NORMAL event via the same pipeline
// as a manual tap (score, box score, totals all follow), then marks
// the candidate confirmed — or corrected if the coach changed the
// stat and/or player. entry_method 'ai' marks it as AI-proposed,
// human-confirmed.
app.post(
  '/api/analysis/candidates/:candidateId/confirm',
  requirePermission('reels'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const candidateId = String(req.params.candidateId);
    const { stat, player_id } = req.body ?? {};
    try {
      const cand = await db.query(
        `SELECT c.*, j.game_id FROM analysis_candidates c
         JOIN analysis_jobs j ON j.id = c.job_id WHERE c.id = $1`,
        [candidateId],
      );
      if (cand.rows.length === 0) {
        res.status(404).json({ ok: false, error: 'Candidate not found.' });
        return;
      }
      const candidate = cand.rows[0];
      const game = await getOrgGame(db, req, candidate.game_id);
      if (!game) {
        res.status(404).json({ ok: false, error: 'Candidate not found.' });
        return;
      }
      if (candidate.status !== 'pending') {
        res.status(400).json({ ok: false, error: 'This candidate was already reviewed.' });
        return;
      }
      const finalStat = typeof stat === 'string' && stat.trim() ? stat.trim() : candidate.proposed_stat;
      if (!VALID_AI_STATS.has(finalStat)) {
        res.status(400).json({ ok: false, error: 'Unknown stat type.' });
        return;
      }
      const finalPlayerId =
        player_id === null ? null : typeof player_id === 'string' ? player_id : candidate.proposed_player_id;
      if (finalPlayerId) {
        const p = await db.query(
          'SELECT id FROM players WHERE id = $1 AND team_id = $2',
          [finalPlayerId, game.team_id],
        );
        if (p.rows.length === 0) {
          res.status(400).json({ ok: false, error: 'Player is not on this game\'s team.' });
          return;
        }
      }
      const { side, points } = aiStatToSidePoints(finalStat);
      const corrected =
        finalStat !== candidate.proposed_stat ||
        (finalPlayerId ?? null) !== (candidate.proposed_player_id ?? null);
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const event = await client.query(
          `INSERT INTO game_events (game_id, player_id, stat_type, side, points, video_seconds, entry_method)
           VALUES ($1, $2, $3, $4, $5, $6, 'ai') RETURNING *`,
          [candidate.game_id, finalPlayerId, finalStat, side, points, Math.round(candidate.timestamp_sec)],
        );
        if (points > 0) {
          const column = side === 'ours' ? 'our_score' : 'opponent_score';
          await client.query(`UPDATE games SET ${column} = ${column} + $1 WHERE id = $2`, [points, candidate.game_id]);
        }
        await client.query(
          `UPDATE analysis_candidates
           SET status = $2, final_stat = $3, final_player_id = $4 WHERE id = $1`,
          [candidateId, corrected ? 'corrected' : 'confirmed', finalStat, finalPlayerId],
        );
        await client.query('COMMIT');
        res.status(201).json({
          ok: true,
          event: event.rows[0],
          candidate: { ...candidate, status: corrected ? 'corrected' : 'confirmed', final_stat: finalStat, final_player_id: finalPlayerId },
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      if (isMissingAiAnalysisTable(err)) {
        res.status(503).json({ ok: false, error: AI_ANALYSIS_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

// Skip a candidate: no event is written.
app.post(
  '/api/analysis/candidates/:candidateId/skip',
  requirePermission('reels'),
  asyncHandler(async (req, res) => {
    const db = getPool();
    const candidateId = String(req.params.candidateId);
    try {
      const cand = await db.query(
        `SELECT c.*, j.game_id FROM analysis_candidates c
         JOIN analysis_jobs j ON j.id = c.job_id WHERE c.id = $1`,
        [candidateId],
      );
      if (cand.rows.length === 0) {
        res.status(404).json({ ok: false, error: 'Candidate not found.' });
        return;
      }
      const game = await getOrgGame(db, req, cand.rows[0].game_id);
      if (!game) {
        res.status(404).json({ ok: false, error: 'Candidate not found.' });
        return;
      }
      if (cand.rows[0].status !== 'pending') {
        res.status(400).json({ ok: false, error: 'This candidate was already reviewed.' });
        return;
      }
      await db.query(`UPDATE analysis_candidates SET status = 'skipped' WHERE id = $1`, [candidateId]);
      res.json({ ok: true, candidate: { ...cand.rows[0], status: 'skipped' } });
    } catch (err) {
      if (isMissingAiAnalysisTable(err)) {
        res.status(503).json({ ok: false, error: AI_ANALYSIS_MIGRATION_MESSAGE });
        return;
      }
      throw err;
    }
  }),
);

// ------------------------------------------- public privacy policy
// Served at /privacy so the Google OAuth verification submission has
// a live privacy-policy URL on the app's own domain.
app.get('/privacy', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SimpliGame — Privacy Policy</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.6;color:#1a1a1a}h1{font-size:28px}h2{font-size:19px;margin-top:28px}a{color:#16408F}</style>
</head><body>
<h1>SimpliGame Privacy Policy</h1>
<p><strong>Effective date:</strong> October 17, 2026</p>
<p>SimpliGame ("the App") is a stat-tracking and video tool for youth and amateur sports clubs. This policy explains what information the App collects, how it is used, and the choices you have. By using the App, you agree to this policy.</p>
<h2>Information we collect</h2>
<ul>
<li><strong>Organization and team information</strong> entered by a coach: organization name, branding colors and logo, team names, and roster details (player names, jersey numbers, positions, and, on recruiting profiles, grad year, school, club, bio, and measurables).</li>
<li><strong>Game data</strong> entered or tagged by a coach: opponents, scores, stat events, substitutions, and YouTube video IDs with timestamps.</li>
<li><strong>Family contact information</strong> that families enroll themselves: a phone number per player, provided only to receive game watch links and highlights-ready alerts. Coaches see masked numbers only.</li>
<li><strong>Google account access (OAuth):</strong> when a coach connects Google, the App can create spreadsheets in that coach's Google Drive and write game data into them. The App does not read other files in the Drive. The Google Drive scope is limited to files the App creates or opens.</li>
<li><strong>SMS delivery logs:</strong> records of alert attempts (recipient masked, status, time) so coaches can confirm delivery.</li>
<li><strong>Export records:</strong> links to spreadsheets the coach exported.</li>
</ul>
<h2>How we use information</h2>
<p>Information is used only to operate the App: live stat tagging, box scores, watch links, recruiting profiles, highlight reels, Google Sheets exports, and family SMS alerts. We do not sell personal information, and we do not use it for advertising.</p>
<h2>Sharing</h2>
<p>Information is shared only with the service providers needed to run the App: hosting (Render / Neon Postgres), Twilio (SMS delivery), Google APIs (Sheets and Drive exports, only when a coach triggers an export), and YouTube (video embeds for videos the coach links). Published watch links and recruiting profiles are coach-controlled, unlisted, token-only links — they are not indexed, searchable, or browsable. A coach can unpublish or regenerate any link at any time.</p>
<h2>Youth sports data</h2>
<p>SimpliGame is used by youth sports organizations. Roster and profile information about minors is entered by coaches or clubs, not collected directly from children. Public pages expose only what a coach has explicitly published, behind unguessable token links. A parent or guardian may request removal of a player's information by contacting us below, or through the player's coach.</p>
<h2>Data retention and deletion</h2>
<p>Data is retained while the organization uses the App. A coach may unpublish links at any time. To request deletion of an organization's data, contact us below.</p>
<h2>Security</h2>
<p>Connections are encrypted (HTTPS). Public pages are protected by unguessable tokens. No system is perfectly secure, and we do not claim the App cannot be breached — we use standard managed-hosting practices to protect stored data.</p>
<h2>Changes to this policy</h2>
<p>Updates will be posted at this URL. Continued use of the App after a change means you accept the updated policy.</p>
<h2>Contact</h2>
<p>Questions or deletion requests: <a href="mailto:APP_CONTACT_EMAIL">APP_CONTACT_EMAIL</a>.</p>
</body></html>`);
});

// ------------------------------------------- public terms of service
// Served at /terms, linked from the app footer. Plain-language terms
// stating the owner's rights in the software and design.
app.get('/terms', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SimpliGame — Terms of Service</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.6;color:#1a1a1a}h1{font-size:28px}h2{font-size:19px;margin-top:28px}a{color:#16408F}</style>
</head><body>
<h1>SimpliGame Terms of Service</h1>
<p><strong>Effective date:</strong> October 19, 2026</p>
<p>SimpliGame ("the App") is a stat-tracking and video tool for youth and amateur sports clubs. By using the App, you agree to these terms.</p>
<h2>Intellectual property</h2>
<p>The App — including its software, design, layout, features, graphics, and content (other than team data entered by coaches, described below) — is the intellectual property of SimpliGame. © 2026 SimpliGame. All rights reserved.</p>
<h2>Prohibited actions</h2>
<p>You may not reverse-engineer, decompile, scrape, copy, clone, or redistribute the App, its software, or its design, in whole or in part, except where such a restriction is prohibited by applicable law. You may not use the App to build a competing copy of the service, and you may not access accounts, teams, or data that are not yours.</p>
<h2>Your data</h2>
<p>Coaches and clubs own the team data they enter into the App (rosters, game data, profiles, and contact information families enroll). SimpliGame processes that data only to operate the service — for example, to generate box scores, watch links, profiles, reels, exports, and alerts — and does not sell it or use it for advertising.</p>
<h2>Service provided as-is</h2>
<p>The App is provided "as is" and "as available," without warranties of any kind, express or implied. We do not guarantee the App will be uninterrupted, error-free, or that stats, video, or exports will always be accurate or complete. Your use of the App is at your own risk.</p>
<h2>Changes to these terms</h2>
<p>The owner may update these terms at any time. Updates will be posted at this URL. Continued use of the App after a change means you accept the updated terms.</p>
<h2>Contact</h2>
<p>Questions about these terms: <a href="mailto:APP_CONTACT_EMAIL">APP_CONTACT_EMAIL</a>.</p>
</body></html>`);
});


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
