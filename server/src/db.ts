import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

/**
 * With DATABASE_SSL=true, TLS is configured here rather than via ?sslmode= in the URL, whose meaning
 * differs between pg versions. The server certificate is verified (hosted Postgres such as Neon uses
 * publicly trusted certificates); set DATABASE_SSL_INSECURE=true only for self-signed setups.
 */
export function createPool(connectionString = config.databaseUrl): pg.Pool {
  if (!config.databaseSsl) return new pg.Pool({ connectionString, max: 5 });
  const url = new URL(connectionString);
  for (const param of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) url.searchParams.delete(param);
  return new pg.Pool({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: process.env.DATABASE_SSL_INSECURE !== 'true' },
    max: 5,
  });
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

/** Applies every *.sql file in /migrations once, tracked in schema_migrations. */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  );
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (done.rowCount) continue;
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  return applied;
}
