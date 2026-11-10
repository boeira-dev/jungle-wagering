import { Client } from 'pg';
import { migrations } from './index';
import type { Migration } from './types';

export type MigrationDirection = 'up' | 'down' | 'down-all';

export interface MigrationResult {
  applied: string[];
  reverted: string[];
}

async function appliedIds(client: Client): Promise<string[]> {
  const result = await client.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id');
  return result.rows.map((row) => row.id);
}

/**
 * Lightweight, fully reversible migration runner. Every migration runs inside
 * its own SQL transaction; the version is recorded in the same transaction so a
 * crash can never leave a half-applied version marked as done.
 */
export async function migrate(
  databaseUrl: string,
  direction: MigrationDirection = 'up',
): Promise<MigrationResult> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  const reverted: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id varchar(128) PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const current = await appliedIds(client);

    if (direction === 'up') {
      for (const migration of migrations) {
        if (current.includes(migration.id)) continue;
        await runInTransaction(client, migration.up, async () => {
          await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
        });
        applied.push(migration.id);
      }
      return { applied, reverted };
    }

    const ordered = [...current].reverse();
    const targets: Migration[] =
      direction === 'down-all'
        ? (ordered
            .map((id) => migrations.find((m) => m.id === id))
            .filter((m): m is Migration => Boolean(m)))
        : (() => {
            const last = ordered[0];
            if (!last) return [];
            const migration = migrations.find((m) => m.id === last);
            return migration ? [migration] : [];
          })();

    for (const migration of targets) {
      await runInTransaction(client, migration.down, async () => {
        await client.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
      });
      reverted.push(migration.id);
    }
    return { applied, reverted };
  } finally {
    await client.end();
  }
}

async function runInTransaction(client: Client, sql: string, record: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await record();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
