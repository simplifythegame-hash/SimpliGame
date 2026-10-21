import { Pool } from 'pg';

/**
 * Shared Postgres connection pool.
 *
 * DATABASE_URL comes from the environment (Neon in production today;
 * a plain Postgres on the owner's own box later). The pool is created
 * lazily on first query so importing this module never crashes a
 * process that has no database configured yet.
 *
 * SSL RULE (box-readiness — do not simplify this away):
 * Hosted Postgres (Neon, today's production) REQUIRES SSL, and the
 * current Render deploy must keep working untouched, so SSL stays ON
 * by default. It is turned OFF only when the target is provably
 * local:
 *   1. `PGSSL=disable` in the environment forces SSL off;
 *      `PGSSL=require` forces it on. (Explicit operator override.)
 *   2. An `sslmode` in DATABASE_URL wins next: require / verify-ca /
 *      verify-full → SSL on; disable → SSL off. (Neon's connection
 *      strings carry sslmode=require, so production takes this path
 *      and is unchanged.)
 *   3. Otherwise the hostname decides: localhost / loopback IPs and
 *      single-label hostnames (no dot — Docker Compose service names
 *      like `db`, which can never be a public hosted endpoint) get a
 *      plain connection. Every dotted hostname (e.g. a Neon
 *      `*.aws.neon.tech` host) gets SSL.
 *   4. An unparseable DATABASE_URL falls back to SSL ON — today's
 *      behavior — so a surprise can never silently downgrade the
 *      production connection to plaintext.
 * When SSL is on, `rejectUnauthorized: false` is kept: it is the
 * standard Neon-compatible setting for pooled clients (Neon presents
 * a publicly trusted chain, but poolers/proxies vary).
 */
type PgSslConfig = { rejectUnauthorized: false } | false;

export function sslConfigForConnectionString(connectionString: string): PgSslConfig {
  const pgssl = (process.env.PGSSL ?? '').trim().toLowerCase();
  if (pgssl === 'require') return { rejectUnauthorized: false };
  if (pgssl === 'disable' || pgssl === 'off' || pgssl === 'false') return false;

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return { rejectUnauthorized: false };
  }

  const sslmode = (url.searchParams.get('sslmode') ?? '').trim().toLowerCase();
  if (sslmode === 'require' || sslmode === 'verify-ca' || sslmode === 'verify-full') {
    return { rejectUnauthorized: false };
  }
  if (sslmode === 'disable') return false;

  const host = url.hostname.toLowerCase();
  const isLocal =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    !host.includes('.');
  return isLocal ? false : { rejectUnauthorized: false };
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set. Copy .env.example to .env and set it.');
    }
    pool = new Pool({
      connectionString,
      max: 10,
      ssl: sslConfigForConnectionString(connectionString),
    });
    pool.on('error', (err) => {
      // A pool error must never take the server down silently; log it loudly.
      console.error('Unexpected pg pool error:', err);
    });
  }
  return pool;
}

/**
 * The caller's organization.
 *
 * With an orgId (the authenticated user's org): returns that org, or
 * throws when it doesn't exist — never silently serves another org.
 * Without one (one-time setup only): the legacy v1 behavior — first org,
 * or a default org created on first use.
 */
export async function getOrCreateOrganization(orgId?: string) {
  const db = getPool();
  if (orgId !== undefined) {
    const row = await db.query('SELECT * FROM organizations WHERE id = $1', [orgId]);
    if (row.rows.length === 0) throw new Error('Organization not found.');
    return row.rows[0];
  }
  const existing = await db.query('SELECT * FROM organizations ORDER BY created_at ASC LIMIT 1');
  if (existing.rows.length > 0) return existing.rows[0];
  const created = await db.query(
    `INSERT INTO organizations (name, primary_color, secondary_color)
     VALUES ($1, $2, $3) RETURNING *`,
    ['NWA Llamas', '#04BEF1', '#048DF1'],
  );
  return created.rows[0];
}
