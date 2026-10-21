import crypto from 'crypto';
import type express from 'express';
import { getPool } from './db';

/**
 * Coach logins + team-scoped permissions.
 *
 * Passwords: scrypt hashes only (salt + 64-byte derived key), verified
 * with timingSafeEqual. Never stored or logged in plaintext.
 * Sessions: opaque tokens (32 random bytes), stored only as SHA-256
 * hashes, delivered as an HttpOnly SameSite=Lax cookie, 30-day expiry.
 *
 * Roles: owner (sees all teams, manages coaches), head_coach /
 * assistant / stat_crew (see only their assigned teams), and parent
 * (migration 012 — a real login linked to one or more players via
 * parent_players; sees ONLY their linked players and their own Drive
 * imports, and holds NONE of the coach permissions — the role ranks
 * below stat_crew, so every coach action 403s). Team scoping is
 * enforced server-side in every handler — the client only renders
 * what the server returns.
 */

export type CoachRole = 'owner' | 'head_coach' | 'assistant' | 'stat_crew' | 'parent';
export type NonOwnerRole = 'head_coach' | 'assistant' | 'stat_crew';

export const NON_OWNER_ROLES: NonOwnerRole[] = ['head_coach', 'assistant', 'stat_crew'];

export interface AuthUser {
  id: string;
  org_id: string;
  email: string;
  name: string;
  role: CoachRole;
}

export interface AuthContext {
  user: AuthUser;
  /** null = owner (sees all teams); otherwise the assigned team IDs. */
  teamIds: string[] | null;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      /** True when the users/sessions tables don't exist yet (migration
       *  009 not run). The app reports a clear setup message instead of
       *  a generic 500. */
      authUnavailable?: boolean;
    }
  }
}

/** Postgres "relation does not exist" — the auth tables aren't there yet. */
export function isMissingTable(err: unknown): boolean {
  return (err as { code?: string }).code === '42P01';
}

const SESSION_COOKIE = 'sg_session';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

// A fixed dummy hash so login timing doesn't reveal whether an email
// exists: unknown emails still pay for one scrypt verification.
const DUMMY_HASH = hashPassword('__simpligame_no_such_user__');

/** scrypt hash, format `scrypt$<salt hex>$<derived hex>`. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  let derived: Buffer;
  try {
    derived = crypto.scryptSync(password, salt, 64);
  } catch {
    return false;
  }
  const expected = Buffer.from(expectedHex, 'hex');
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(expected, derived);
}

/** Burns one scrypt verification so unknown-email logins take as long as real ones. */
export function dummyPasswordCheck(password: string): void {
  verifyPassword(password, DUMMY_HASH);
}

export function newSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function sessionCookieValue(token: string): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

function parseSessionCookie(req: express.Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

/**
 * Attaches req.auth when the request carries a valid, unexpired session
 * cookie. Runs on every /api route; never rejects — requireAuth decides.
 * Missing auth tables (migration 009 not run) set authUnavailable.
 */
export async function authenticate(
  req: express.Request,
  _res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const token = parseSessionCookie(req);
  if (!token) {
    next();
    return;
  }
  try {
    const db = getPool();
    const row = await db.query(
      `SELECT s.id AS session_id, s.expires_at,
              u.id, u.org_id, u.email, u.name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1`,
      [hashSessionToken(token)],
    );
    if (row.rows.length === 0) {
      next();
      return;
    }
    const session = row.rows[0];
    if (new Date(session.expires_at).getTime() < Date.now()) {
      await db.query('DELETE FROM sessions WHERE id = $1', [session.session_id]).catch(() => {
        // Expired session cleanup is best-effort; the login is rejected either way.
      });
      next();
      return;
    }
    const user: AuthUser = {
      id: session.id as string,
      org_id: session.org_id as string,
      email: session.email as string,
      name: session.name as string,
      role: session.role as CoachRole,
    };
    let teamIds: string[] | null = null;
    if (user.role !== 'owner') {
      const teams = await db.query('SELECT team_id FROM coach_teams WHERE user_id = $1', [user.id]);
      teamIds = teams.rows.map((r) => r.team_id as string);
    }
    req.auth = { user, teamIds };
    next();
  } catch (err) {
    if (isMissingTable(err)) {
      req.authUnavailable = true;
      next();
      return;
    }
    // A database error here must not take down public routes — log it
    // and continue unauthenticated; protected routes reject below.
    console.error('Auth lookup failed:', err);
    next();
  }
}

/** Rejects unauthenticated /api requests. Public routes never reach this. */
export function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (req.authUnavailable) {
    res.status(503).json({
      ok: false,
      error: 'Coach logins are not set up yet — run migrations/009_coach_auth.sql in the Neon SQL Editor, then restart.',
    });
    return;
  }
  if (!req.auth) {
    res.status(401).json({ ok: false, error: 'Please log in.' });
    return;
  }
  next();
}

/** Owner-only routes (coach management, team creation, org rename). */
export function requireOwner(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (req.auth?.user.role !== 'owner') {
    res.status(403).json({ ok: false, error: 'Only the owner can do that.' });
    return;
  }
  next();
}

/**
 * Per-role write permissions. One helper for every write endpoint —
 * handlers never write their own ad-hoc role checks.
 *
 * Rank: owner (4) > head_coach (3) > assistant (2) > stat_crew (1) >
 * parent (0). Each action names the minimum role that may perform it;
 * higher roles inherit it. Team scoping is separate (canAccessTeam /
 * getOrgGame): the role check runs first (403), then the team check
 * (404 for an unassigned team). A 403 never reveals whether the
 * resource exists, because it is returned without looking the
 * resource up.
 *
 * - parent: NO coach actions. Parent reads go through the dedicated
 *   /api/parent/* endpoints, scoped to their linked players.
 * - stat_crew: tag stats + undo + view only.
 * - assistant: + subs, Go Live / End Game, analysis verify/unverify.
 * - head_coach: + game creation, roster changes, publish/unpublish,
 *   exports, profile edits, reels, family-notify sends, YouTube attach,
 *   enroll-token generation, family-contact removal, parent management.
 * - owner: everything, + coach management, org rename, team creation.
 */
export type PermissionAction =
  | 'tag_stats'
  | 'sub'
  | 'game_status'
  | 'analysis_review'
  | 'game_create'
  | 'roster'
  | 'publish'
  | 'export'
  | 'profile_edit'
  | 'reels'
  | 'family_notify'
  | 'youtube'
  | 'enroll'
  | 'family_manage'
  | 'parent_manage'
  | 'coach_manage'
  | 'org'
  | 'team_create';

const ROLE_RANK: Record<CoachRole, number> = {
  owner: 4,
  head_coach: 3,
  assistant: 2,
  stat_crew: 1,
  parent: 0,
};

const MIN_ROLE: Record<PermissionAction, CoachRole> = {
  tag_stats: 'stat_crew',
  sub: 'assistant',
  game_status: 'assistant',
  analysis_review: 'assistant',
  game_create: 'head_coach',
  roster: 'head_coach',
  publish: 'head_coach',
  export: 'head_coach',
  profile_edit: 'head_coach',
  reels: 'head_coach',
  family_notify: 'head_coach',
  youtube: 'head_coach',
  enroll: 'head_coach',
  family_manage: 'head_coach',
  parent_manage: 'head_coach',
  coach_manage: 'owner',
  org: 'owner',
  team_create: 'owner',
};

export function can(role: CoachRole, action: PermissionAction): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[MIN_ROLE[action]];
}

/** Middleware: 403 when the signed-in role may not perform `action`. */
export function requirePermission(action: PermissionAction) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const role = req.auth?.user.role;
    if (!role || !can(role, action)) {
      res.status(403).json({ ok: false, error: 'Your role does not allow this action.' });
      return;
    }
    next();
  };
}

/** The authenticated user, or throws — the /api gate guarantees auth on protected routes. */
export function authOf(req: express.Request): AuthContext {
  if (!req.auth) throw new Error('Request is not authenticated.');
  return req.auth;
}

/** Team access check: owners see everything; coaches see assigned teams only. */
export function canAccessTeam(auth: AuthContext, teamId: string): boolean {
  return auth.teamIds === null || auth.teamIds.includes(teamId);
}

/** Public shape of a user — never includes password_hash. created_at is
 *  null for the session user (AuthUser carries no timestamp). */
export function publicUser(row: {
  id: string;
  org_id: string;
  email: string;
  name: string;
  role: string;
  created_at?: string;
}) {
  return {
    id: row.id,
    org_id: row.org_id,
    email: row.email,
    name: row.name,
    role: row.role,
    created_at: row.created_at ?? null,
  };
}

/** Normalize + validate an email: lowercase, trimmed, basic shape, ≤254 chars. */
export function cleanEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/** Passwords: 8–200 chars. No complexity rules — length is the gate. */
export function cleanPassword(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length < 8 || value.length > 200) return null;
  return value;
}

/** Display name: trimmed, non-empty, ≤100 chars. */
export function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (name.length === 0 || name.length > 100) return null;
  return name;
}

/** Validate a teamIds array from a request body: strings only. */
export function cleanTeamIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (typeof item !== 'string' || !item) return null;
  }
  return value as string[];
}
