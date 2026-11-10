import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ReferenceResolutionWorker } from '../../src/application/wagering/reference-resolution.worker';
import { config } from '../../src/config';
import {
  createTestContext,
  makeCommand,
  query,
  unique,
  type TestContext,
} from '../support/context';

let context: TestContext;

beforeAll(async () => {
  context = await createTestContext();
});

afterAll(async () => {
  await context.close();
});

async function createWallet(initialBalance = '100.00') {
  return context.wallets.create({
    playerId: unique('player'),
    currency: 'BRL',
    initialBalance,
  });
}

interface TransactionState {
  status: string;
  attempts: number;
  failure_code: string | null;
  next_attempt_at: Date | string | null;
  processed_at: Date | string | null;
  balance_after: string | null;
  reference_transaction_id: string | null;
}

async function transactionState(id: string): Promise<TransactionState> {
  const [row] = await query<TransactionState>(
    context,
    `SELECT status, attempts, failure_code, next_attempt_at, processed_at,
            balance_after, reference_transaction_id
     FROM wager_transactions WHERE id = ?`,
    [id],
  );
  return row;
}

async function makeDue(id: string): Promise<void> {
  await query(
    context,
    "UPDATE wager_transactions SET next_attempt_at = now() - interval '1 second' WHERE id = ?",
    [id],
  );
}

/**
 * Other test files may leave PENDING_REFERENCE rows behind. Park every pending
 * row so a drain only sees what the current test explicitly makes due.
 */
async function parkAllPending(): Promise<void> {
  await query(
    context,
    `UPDATE wager_transactions
     SET next_attempt_at = now() + interval '1 hour'
     WHERE status = 'PENDING_REFERENCE'`,
  );
}

function asTime(value: Date | string | null): number {
  return value === null ? 0 : new Date(value).getTime();
}

describe('reference resolution worker', () => {
  it('honours next_attempt_at and backs off exponentially', async () => {
    const wallet = await createWallet('100.00');
    const pending = await context.submit.execute(
      makeCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'REFUND',
        amount: '10.00',
        referenceExternalTransactionId: unique('missing'),
      }),
    );
    expect(pending.status).toBe('PENDING_REFERENCE');

    await parkAllPending();
    expect(await context.referenceWorker.drain()).toBe(0);
    let state = await transactionState(pending.transactionId);
    expect(state.attempts).toBe(1);

    await makeDue(pending.transactionId);
    expect(await context.referenceWorker.drain()).toBeGreaterThanOrEqual(1);

    state = await transactionState(pending.transactionId);
    expect(state.status).toBe('PENDING_REFERENCE');
    expect(state.attempts).toBe(2);

    const delayMs = asTime(state.next_attempt_at) - Date.now();
    expect(delayMs).toBeGreaterThan(8_000);
    expect(delayMs).toBeLessThanOrEqual(11_000);

    await parkAllPending();
    expect(await context.referenceWorker.drain()).toBe(0);
    expect((await transactionState(pending.transactionId)).attempts).toBe(2);
  });

  it('processes a pending REFUND once the referenced BET is committed', async () => {
    const wallet = await createWallet('100.00');
    const betExternal = unique('late-bet');
    const refund = await context.submit.execute(
      makeCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'REFUND',
        amount: '10.00',
        referenceExternalTransactionId: betExternal,
      }),
    );
    expect(refund.status).toBe('PENDING_REFERENCE');

    const bet = await context.submit.execute(
      makeCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'BET',
        amount: '10.00',
        externalTransactionId: betExternal,
      }),
    );
    expect(bet.status).toBe('PROCESSED');
    expect(bet.balance).toBe('90.00');

    await parkAllPending();
    await makeDue(refund.transactionId);
    expect(await context.referenceWorker.drain()).toBeGreaterThanOrEqual(1);

    const state = await transactionState(refund.transactionId);
    expect(state.status).toBe('PROCESSED');
    expect(state.reference_transaction_id).toBe(bet.transactionId);
    expect(state.balance_after).toBe('100.00');
    expect(state.next_attempt_at).toBeNull();

    const [stored] = await query<{ balance: string; version: number }>(
      context,
      'SELECT balance, version FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(stored).toEqual({ balance: '100.00', version: 3 });

    const ledger = await query<{
      direction: string;
      amount: string;
      balance_before: string;
      balance_after: string;
    }>(
      context,
      `SELECT direction, amount, balance_before, balance_after
       FROM wallet_ledger_entries WHERE transaction_id = ?`,
      [refund.transactionId],
    );
    expect(ledger).toEqual([
      {
        direction: 'CREDIT',
        amount: '10.00',
        balance_before: '90.00',
        balance_after: '100.00',
      },
    ]);

    const outbox = await query<{ event_type: string }>(
      context,
      "SELECT event_type FROM outbox_messages WHERE payload->>'causationId' = ?",
      [refund.transactionId],
    );
    expect(outbox.map((row) => row.event_type).sort()).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('rejects with REFERENCE_NOT_FOUND_EXPIRED after the maximum number of attempts', async () => {
    const wallet = await createWallet('100.00');
    const pending = await context.submit.execute(
      makeCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'REFUND',
        amount: '10.00',
        referenceExternalTransactionId: unique('never-arrives'),
      }),
    );

    await parkAllPending();
    await query(
      context,
      "UPDATE wager_transactions SET attempts = ?, next_attempt_at = now() - interval '1 second' WHERE id = ?",
      [config.referenceWorker.maxAttempts, pending.transactionId],
    );

    expect(await context.referenceWorker.drain()).toBeGreaterThanOrEqual(1);

    const state = await transactionState(pending.transactionId);
    expect(state.status).toBe('REJECTED');
    expect(state.failure_code).toBe('REFERENCE_NOT_FOUND_EXPIRED');
    expect(state.next_attempt_at).toBeNull();
    expect(state.processed_at).not.toBeNull();
    expect(state.balance_after).toBe('100.00');

    const outbox = await query<{ event_type: string }>(
      context,
      "SELECT event_type FROM outbox_messages WHERE payload->>'causationId' = ?",
      [pending.transactionId],
    );
    expect(outbox.map((row) => row.event_type).sort()).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
  });

  it('rejects a reference that outlives the TTL even below max attempts', async () => {
    const wallet = await createWallet('100.00');
    const pending = await context.submit.execute(
      makeCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'REFUND',
        amount: '10.00',
        referenceExternalTransactionId: unique('too-old'),
      }),
    );

    await parkAllPending();
    await query(
      context,
      `UPDATE wager_transactions
       SET created_at = now() - interval '20 minutes',
           next_attempt_at = now() - interval '1 second'
       WHERE id = ?`,
      [pending.transactionId],
    );

    expect(await context.referenceWorker.drain()).toBeGreaterThanOrEqual(1);

    const state = await transactionState(pending.transactionId);
    expect(state.status).toBe('REJECTED');
    expect(state.failure_code).toBe('REFERENCE_NOT_FOUND_EXPIRED');
    expect(state.attempts).toBe(1);
  });

  it('processes each referenced reversal exactly once under concurrent workers', async () => {
    const wallet = await createWallet('100.00');
    const betExternal = unique('shared-bet');

    const refunds = [];
    for (let index = 0; index < 20; index++) {
      refunds.push(
        await context.submit.execute(
          makeCommand({
            walletId: wallet.id,
            playerId: wallet.playerId,
            kind: 'REFUND',
            amount: '10.00',
            externalTransactionId: unique('refund'),
            idempotencyKey: unique('refund-key'),
            referenceExternalTransactionId: betExternal,
          }),
        ),
      );
    }
    expect(refunds.every((refund) => refund.status === 'PENDING_REFERENCE')).toBe(true);

    await parkAllPending();

    const bet = await context.submit.execute(
      makeCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'BET',
        amount: '10.00',
        externalTransactionId: betExternal,
      }),
    );
    expect(bet.status).toBe('PROCESSED');

    await query(
      context,
      `UPDATE wager_transactions
       SET next_attempt_at = now() - interval '1 second'
       WHERE wallet_id = ? AND status = 'PENDING_REFERENCE'`,
      [wallet.id],
    );

    const workers = Array.from(
      { length: 5 },
      () => new ReferenceResolutionWorker(context.submit),
    );
    await Promise.all(workers.map((worker) => worker.drain()));

    const rows = await query<{ status: string; failure_code: string | null }>(
      context,
      "SELECT status, failure_code FROM wager_transactions WHERE wallet_id = ? AND kind = 'REFUND'",
      [wallet.id],
    );
    expect(rows.filter((row) => row.status === 'PROCESSED')).toHaveLength(1);
    expect(
      rows.filter(
        (row) => row.status === 'REJECTED' && row.failure_code === 'ALREADY_REVERSED',
      ),
    ).toHaveLength(19);

    const [stored] = await query<{ balance: string; version: number }>(
      context,
      'SELECT balance, version FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(stored).toEqual({ balance: '100.00', version: 3 });

    const ledger = await query<{ direction: string }>(
      context,
      'SELECT direction FROM wallet_ledger_entries WHERE wallet_id = ?',
      [wallet.id],
    );
    expect(ledger.filter((entry) => entry.direction === 'CREDIT')).toHaveLength(2);
    expect(ledger.filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);
  });
});
