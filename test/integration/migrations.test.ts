import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { migrate } from '../../src/infrastructure/database/migrations/runner';

const DATABASE_URL =
  process.env.MIG_DATABASE_URL ?? 'postgresql://jungle:jungle_local@127.0.0.1:15432/jungle_test_mig';

const HASH = 'a'.repeat(64);

let client: Client;
let walletId: string;

async function resetSchema(): Promise<void> {
  const reset = new Client({ connectionString: DATABASE_URL });
  await reset.connect();
  try {
    await reset.query('DROP SCHEMA IF EXISTS public CASCADE');
    await reset.query('CREATE SCHEMA public');
  } finally {
    await reset.end();
  }
}

async function tableExists(name: string): Promise<boolean> {
  const result = await client.query<{ t: string | null }>('SELECT to_regclass($1) AS t', [
    `public.${name}`,
  ]);
  return result.rows[0]?.t != null;
}

async function expectReject(sql: string, params: unknown[] = []): Promise<Error> {
  let caught: Error | undefined;
  try {
    await client.query(sql, params);
  } catch (error) {
    caught = error as Error;
  }
  expect(caught).toBeDefined();
  return caught as Error;
}

interface TxSeed {
  id?: string;
  playerId?: string;
  kind?: string;
  external?: string;
  key?: string;
  status?: string;
  referenceExternal?: string | null;
  referenceId?: string | null;
  balanceAfter?: string | null;
  processedAt?: Date | null;
  failureCode?: string | null;
  nextAttemptAt?: Date | null;
}

async function insertTransaction(seed: TxSeed = {}): Promise<string> {
  const id = seed.id ?? randomUUID();
  const kind = seed.kind ?? 'BET';
  const status = seed.status ?? 'PROCESSED';
  const baseProcessed = status === 'PROCESSED';
  const balanceAfter = seed.balanceAfter === undefined ? (baseProcessed ? '0.00' : null) : seed.balanceAfter;
  const processedAt =
    seed.processedAt === undefined ? (baseProcessed ? new Date() : null) : seed.processedAt;
  const failureCode =
    seed.failureCode === undefined
      ? status === 'REJECTED' || status === 'FAILED'
        ? 'SOME_FAILURE'
        : null
      : seed.failureCode;
  await client.query(
    `INSERT INTO wager_transactions
      (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
       player_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
       status, failure_code, attempts, next_attempt_at, balance_after, processed_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      id,
      'provider-1',
      seed.external ?? `ext-${id}`,
      seed.key ?? `key-${id}`,
      HASH,
      walletId,
      seed.playerId ?? 'player-1',
      kind,
      '10.00',
      'BRL',
      seed.referenceExternal ?? null,
      seed.referenceId ?? null,
      status,
      failureCode,
      0,
      seed.nextAttemptAt ?? (status === 'PENDING_REFERENCE' ? new Date() : null),
      balanceAfter,
      processedAt,
      new Date(),
    ],
  );
  return id;
}

beforeAll(async () => {
  await resetSchema();
  await migrate(DATABASE_URL, 'up');
  client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  walletId = randomUUID();
  await client.query(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
     VALUES ($1, 'player-1', 'BRL', 100.00, 1, now(), now())`,
    [walletId],
  );
  const txId = await insertTransaction({ external: 'seed-bet', key: 'seed-bet' });
  await client.query(
    `INSERT INTO wallet_ledger_entries
      (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
     VALUES ($1,$2,$3,'DEBIT',10.00,'BRL',100.00,90.00,now())`,
    [randomUUID(), walletId, txId],
  );
});

afterAll(async () => {
  if (client) await client.end();
  await resetSchema();
});

describe('migrations and database guarantees', () => {
  it('creates all required tables', async () => {
    for (const table of [
      'wallets',
      'wager_transactions',
      'wallet_ledger_entries',
      'inbox_messages',
      'outbox_messages',
    ]) {
      expect(await tableExists(table)).toBe(true);
    }
  });

  it('enforces wallet balance >= 0', async () => {
    const error = await expectReject('UPDATE wallets SET balance = -1 WHERE id = $1', [walletId]);
    expect(String(error.message)).toContain('wallets_balance_non_negative');
    const current = await client.query('SELECT balance FROM wallets WHERE id = $1', [walletId]);
    expect(current.rows[0].balance).toBe('100.00');
  });

  it('enforces unique wallet per (player_id, currency)', async () => {
    const error = await expectReject(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, 'player-1', 'BRL', 0, 1, now(), now())`,
      [randomUUID()],
    );
    expect(String(error.message)).toContain('wallets_player_currency_unique');
  });

  it('enforces ledger immutability: UPDATE, DELETE and TRUNCATE all fail', async () => {
    const update = await expectReject(
      "UPDATE wallet_ledger_entries SET amount = amount WHERE wallet_id = $1",
      [walletId],
    );
    expect(String(update.message)).toContain('append-only');
    const del = await expectReject('DELETE FROM wallet_ledger_entries WHERE wallet_id = $1', [walletId]);
    expect(String(del.message)).toContain('append-only');
    const truncate = await expectReject('TRUNCATE wallet_ledger_entries');
    expect(String(truncate.message)).toContain('append-only');
  });

  it('enforces at most one ledger entry per (transaction_id, wallet_id)', async () => {
    const rows = await client.query('SELECT transaction_id FROM wallet_ledger_entries LIMIT 1');
    const txId = rows.rows[0].transaction_id as string;
    const error = await expectReject(
      `INSERT INTO wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES ($1,$2,$3,'DEBIT',1.00,'BRL',100.00,99.00,now())`,
      [randomUUID(), walletId, txId],
    );
    expect(String(error.message)).toContain('ledger_transaction_wallet_unique');
  });

  it('enforces balanced ledger arithmetic', async () => {
    const txId = await insertTransaction({ external: 'unbalanced-win' });
    const error = await expectReject(
      `INSERT INTO wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES ($1,$2,$3,'CREDIT',10.00,'BRL',100.00,999.00,now())`,
      [randomUUID(), walletId, txId],
    );
    expect(String(error.message)).toContain('ledger_balanced');
  });

  it('enforces unique idempotency key and unique (provider, external id)', async () => {
    const keyError = await expectReject(
      `INSERT INTO wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         kind, amount, currency, status, created_at, balance_after, processed_at)
       VALUES ($1,'provider-1',$2,'seed-bet',$3,$4,'player-1','BET',1.00,'BRL','PROCESSED',now(),0,now())`,
      [randomUUID(), randomUUID(), HASH, walletId],
    );
    expect(String(keyError.message)).toContain('wager_tx_idempotency_unique');

    const extError = await expectReject(
      `INSERT INTO wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         kind, amount, currency, status, created_at, balance_after, processed_at)
       VALUES ($1,'provider-1','seed-bet',$2,$3,$4,'player-1','BET',1.00,'BRL','PROCESSED',now(),0,now())`,
      [randomUUID(), randomUUID(), HASH, walletId],
    );
    expect(String(extError.message)).toContain('wager_tx_external_unique');
  });

  it('enforces kind/status domain values', async () => {
    await expectReject(
      `INSERT INTO wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         kind, amount, currency, status, created_at, balance_after, processed_at)
       VALUES ($1,'provider-1',$2,$3,$4,$5,'player-1','NOT_A_KIND',1.00,'BRL','PROCESSED',now(),0,now())`,
      [randomUUID(), randomUUID(), randomUUID(), HASH, walletId],
    ).then((e) => expect(String(e.message)).toContain('wager_tx_kind_valid'));

    await expectReject(
      `INSERT INTO wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         kind, amount, currency, status, created_at, balance_after, processed_at)
       VALUES ($1,'provider-1',$2,$3,$4,$5,'player-1','BET',1.00,'BRL','NOT_A_STATUS',now(),0,now())`,
      [randomUUID(), randomUUID(), randomUUID(), HASH, walletId],
    ).then((e) => expect(String(e.message)).toContain('wager_tx_status_valid'));
  });

  it('prevents double reversal of the same reference for the same kind', async () => {
    const base = await insertTransaction({ kind: 'BET', external: 'base-for-reversal' });
    await insertTransaction({
      kind: 'REFUND',
      external: 'refund-1',
      key: 'refund-1',
      referenceExternal: 'base-for-reversal',
      referenceId: base,
    });
    const error = await expectReject(
      `INSERT INTO wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
         status, created_at, balance_after, processed_at)
       VALUES ($1,'provider-1','refund-2','refund-2',$2,$3,'player-1','REFUND',10.00,'BRL','base-for-reversal',$4,
               'PROCESSED',now(),0,now())`,
      [randomUUID(), HASH, walletId, base],
    );
    expect(String(error.message)).toContain('wager_tx_reversal_unique');
  });

  it('reverses cleanly (down), removing tables and trigger function', async () => {
    const result = await migrate(DATABASE_URL, 'down');
    expect(result.reverted).toEqual(['001_initial']);
    for (const table of [
      'wallets',
      'wager_transactions',
      'wallet_ledger_entries',
      'inbox_messages',
      'outbox_messages',
    ]) {
      expect(await tableExists(table)).toBe(false);
    }
    const fn = await client.query("SELECT 1 FROM pg_proc WHERE proname = 'jw_forbid_ledger_mutation'");
    expect(fn.rowCount).toBe(0);
  });
});
