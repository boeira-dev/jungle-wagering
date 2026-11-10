import { Client } from 'pg';
import { config } from '../src/config';
import { migrate } from '../src/infrastructure/database/migrations/runner';

export const TEST_DATABASES = ['jungle_test', 'jungle_test_mig', 'jungle_test_multi'] as const;

export function databaseUrlFor(name: string): string {
  const url = new URL(config.databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function ensureDatabase(name: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrlFor('postgres') });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (existing.rowCount === 0) {
      const safe = name.replace(/"/g, '""');
      await client.query(`CREATE DATABASE "${safe}"`);
      console.log(`created database ${name}`);
    }
  } finally {
    await client.end();
  }
}

async function resetSchema(name: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrlFor(name) });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  for (const name of TEST_DATABASES) {
    await ensureDatabase(name);
    await resetSchema(name);
  }
  await migrate(databaseUrlFor('jungle_test'), 'up');
  await migrate(databaseUrlFor('jungle_test_multi'), 'up');
  // jungle_test_mig is intentionally left empty: the migration test controls it.
  console.log('test databases ready');
}

await main();
