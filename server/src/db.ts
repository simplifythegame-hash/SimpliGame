import { Pool } from 'pg';

/**
 * Shared Postgres connection pool.
 *
 * DATABASE_URL comes from the environment (Neon in production, local
 * Postgres or Neon in dev). Neon requires SSL; `ssl: { rejectUnauthorized:
 * false }` is the standard Neon-compatible setting for pooled clients.
 * The pool is created lazily on first query so importing this module never
 * crashes a process that has no database configured yet.
 */
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
      ssl: { rejectUnauthorized: false },
    });
    pool.on('error', (err) => {
      // A pool error must never take the server down silently; log it loudly.
      console.error('Unexpected pg pool error:', err);
    });
  }
  return pool;
}

/**
 * The v1 single-owner organization. All data belongs to this one org.
 * Creates a default org on first use so a fresh database just works.
 * When multi-org auth lands, this must be replaced by "the caller's org"
 * and every query must scope by it — see README.
 */
export async function getOrCreateOrganization() {
  const db = getPool();
  const existing = await db.query('SELECT * FROM organizations ORDER BY created_at ASC LIMIT 1');
  if (existing.rows.length > 0) return existing.rows[0];
  const created = await db.query(
    `INSERT INTO organizations (name, primary_color, secondary_color)
     VALUES ($1, $2, $3) RETURNING *`,
    ['My Organization', '#04BEF1', '#048DF1'],
  );
  return created.rows[0];
}
