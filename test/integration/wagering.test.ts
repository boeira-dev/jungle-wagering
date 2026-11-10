import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  IdempotencyConflictError,
  InvalidKindError,
  WalletAlreadyExistsError,
} from '../../src/domain/errors';
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

async function createWallet(initialBalance?: string) {
  return context.wallets.create({
    playerId: unique('player'),
    currency: 'BRL',
    initialBalance,
  });
}

describe('wallet creation', () => {
  it('persists balance, opening transaction, ledger and outbox in one commit', async () => {
    const wallet = await createWallet('100.00');
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);

    const [stored] = await query<{ balance: string; version: number }>(
      context,
      'SELECT balance, version FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(stored.balance).toBe('100.00');
    expect(stored.version).toBe(1);

    const [opening] = await query<{
      id: string;
      kind: string;
      status: string;
      balance_after: string;
    }>(
      context,
      'SELECT id, kind, status, balance_after FROM wager_transactions WHERE wallet_id = ?',
      [wallet.id],
    );
    expect(opening.kind).toBe('OPENING');
    expect(opening.status).toBe('PROCESSED');
    expect(opening.balance_after).toBe('100.00');

    const ledger = await query<{ direction: string; amount: string; balance_before: string; balance_after: string }>(
      context,
      'SELECT direction, amount, balance_before, balance_after FROM wallet_ledger_entries WHERE wallet_id = ?',
      [wallet.id],
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toEqual({
      direction: 'CREDIT',
      amount: '100.00',
      balance_before: '0.00',
      balance_after: '100.00',
    });

    const outbox = await query<{ event_type: string }>(
      context,
      "SELECT event_type FROM outbox_messages WHERE payload->>'causationId' = ?",
      [opening.id],
    );
    expect(outbox.map((row) => row.event_type).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('creates a zero-balance wallet without transactions, ledger or events', async () => {
    const wallet = await createWallet();
    expect(wallet.balance.amount).toBe('0.00');
    const transactions = await query(
      context,
      'SELECT 1 FROM wager_transactions WHERE wallet_id = ?',
      [wallet.id],
    );
    const ledger = await query(
      context,
      'SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ?',
      [wallet.id],
    );
    expect(transactions).toHaveLength(0);
    expect(ledger).toHaveLength(0);
  });

  it('rejects a duplicate wallet for the same player and currency', async () => {
    const playerId = unique('duplicate-player');
    await context.wallets.create({ playerId, currency: 'BRL', initialBalance: '1.00' });
    await expect(
      context.wallets.create({ playerId, currency: 'BRL', initialBalance: '2.00' }),
    ).rejects.toBeInstanceOf(WalletAlreadyExistsError);
  });
});

describe('submit use case', () => {
  it('processes a BET and writes wallet, ledger, transaction and outbox atomically', async () => {
    const wallet = await createWallet('100.00');
    const result = await context.submit.execute(
      makeCommand({ walletId: wallet.id, playerId: wallet.playerId, amount: '25.00' }),
    );

    expect(result.status).toBe('PROCESSED');
    expect(result.balance).toBe('75.00');
    expect(result.idempotentReplay).toBe(false);

    const [stored] = await query<{ balance: string; version: number }>(
      context,
      'SELECT balance, version FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(stored).toEqual({ balance: '75.00', version: 2 });

    const [ledger] = await query<{
      direction: string;
      amount: string;
      balance_before: string;
      balance_after: string;
    }>(
      context,
      'SELECT direction, amount, balance_before, balance_after FROM wallet_ledger_entries WHERE transaction_id = ?',
      [result.transactionId],
    );
    expect(ledger).toEqual({
      direction: 'DEBIT',
      amount: '25.00',
      balance_before: '100.00',
      balance_after: '75.00',
    });

    const outbox = await query<{ event_type: string }>(
      context,
      "SELECT event_type FROM outbox_messages WHERE payload->>'causationId' = ?",
      [result.transactionId],
    );
    expect(outbox.map((row) => row.event_type).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('answers replays with the original result and does not duplicate effects', async () => {
    const wallet = await createWallet('100.00');
    const command = makeCommand({
      walletId: wallet.id,
      playerId: wallet.playerId,
      amount: '10.00',
      externalTransactionId: unique('replay-ext'),
      idempotencyKey: unique('replay-key'),
    });

    const first = await context.submit.execute(command);
    const second = await context.submit.execute(command);

    expect(first.status).toBe('PROCESSED');
    expect(second.status).toBe('PROCESSED');
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.balance).toBe(first.balance);

    const [stored] = await query<{ balance: string }>(
      context,
      'SELECT balance FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(stored.balance).toBe('90.00');

    const ledger = await query(
      context,
      'SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = ?',
      [first.transactionId],
    );
    expect(ledger).toHaveLength(1);

    await expect(
      context.submit.execute({ ...command, money: { amount: '11.00', currency: 'BRL' } }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const byExternal = await context.submit.execute({
      ...command,
      idempotencyKey: unique('other-key'),
    });
    expect(byExternal.idempotentReplay).toBe(true);
    expect(byExternal.transactionId).toBe(first.transactionId);
  });

  it('replays SQS messages through the inbox and marks them processed', async () => {
    const wallet = await createWallet('100.00');
    const messageId = unique('message');
    const command = makeCommand({
      walletId: wallet.id,
      playerId: wallet.playerId,
      source: 'sqs',
      consumerName: 'test-consumer',
      messageId,
      amount: '10.00',
    });

    const first = await context.submit.execute(command);
    const second = await context.submit.execute(command);

    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);

    const inbox = await query<{ processed_at: Date | null }>(
      context,
      'SELECT processed_at FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
      ['test-consumer', messageId],
    );
    expect(inbox).toHaveLength(1);
    expect(inbox[0].processed_at).not.toBeNull();

    const [stored] = await query<{ balance: string }>(
      context,
      'SELECT balance FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(stored.balance).toBe('90.00');
  });

  it('rejects kinds that are internal only', async () => {
    const wallet = await createWallet('10.00');
    await expect(
      context.submit.execute({
        ...makeCommand({ walletId: wallet.id, playerId: wallet.playerId }),
        kind: 'OPENING' as never,
      }),
    ).rejects.toBeInstanceOf(InvalidKindError);
  });

  it('rejects player and currency mismatches with the observed balance', async () => {
    const wallet = await createWallet('100.00');

    const playerMismatch = await context.submit.execute(
      makeCommand({ walletId: wallet.id, playerId: unique('other-player') }),
    );
    expect(playerMismatch.status).toBe('REJECTED');
    expect(playerMismatch.failureCode).toBe('PLAYER_MISMATCH');
    expect(playerMismatch.balance).toBe('100.00');

    const currencyMismatch = await context.submit.execute(
      makeCommand({ walletId: wallet.id, playerId: wallet.playerId, currency: 'USD' }),
    );
    expect(currencyMismatch.status).toBe('REJECTED');
    expect(currencyMismatch.failureCode).toBe('CURRENCY_MISMATCH');
    expect(currencyMismatch.balance).toBeNull();

    const [stored] = await query<{ balance: string }>(
      context,
      'SELECT balance FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(stored.balance).toBe('100.00');
  });

  it('processes LOSS without changing the balance or writing a ledger entry', async () => {
    const wallet = await createWallet('100.00');
    const result = await context.submit.execute(
      makeCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'LOSS',
        amount: '30.00',
      }),
    );

    expect(result.status).toBe('PROCESSED');
    expect(result.balance).toBe('100.00');

    const ledger = await query(
      context,
      'SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = ?',
      [result.transactionId],
    );
    expect(ledger).toHaveLength(0);

    const outbox = await query<{ event_type: string }>(
      context,
      'SELECT event_type FROM outbox_messages WHERE aggregate_id = ?',
      [result.transactionId],
    );
    expect(outbox.map((row) => row.event_type)).toEqual(['WagerTransactionProcessed']);
  });

  it('credits WIN and debits the inverse ROLLBACK of that WIN', async () => {
    const wallet = await createWallet('100.00');
    const winExternal = unique('win');
    const win = await context.submit.execute(
      makeCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'WIN',
        amount: '30.00',
        externalTransactionId: winExternal,
      }),
    );
    expect(win.status).toBe('PROCESSED');
    expect(win.balance).toBe('130.00');

    const rollback = await context.submit.execute(
      makeCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'ROLLBACK',
        amount: '30.00',
        referenceExternalTransactionId: winExternal,
      }),
    );
    expect(rollback.status).toBe('PROCESSED');
    expect(rollback.balance).toBe('100.00');
  });

  it('rejects a ROLLBACK that would overdraw the wallet', async () => {
    const wallet = await createWallet('100.00');
    const winExternal = unique('win-overdraw');
    await context.submit.execute(
      makeCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'WIN',
        amount: '50.00',
        externalTransactionId: winExternal,
      }),
    );
    await context.submit.execute(
      makeCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'BET',
        amount: '120.00',
      }),
    );

    const rollback = await context.submit.execute(
      makeCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'ROLLBACK',
        amount: '50.00',
        referenceExternalTransactionId: winExternal,
      }),
    );
    expect(rollback.status).toBe('REJECTED');
    expect(rollback.failureCode).toBe('REVERSAL_WOULD_OVERDRAW');
    expect(rollback.balance).toBe('30.00');
  });

  it('creates a PENDING_REFERENCE transaction when the reference does not exist yet', async () => {
    const wallet = await createWallet('100.00');
    const result = await context.submit.execute(
      makeCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'REFUND',
        amount: '10.00',
        referenceExternalTransactionId: unique('missing-bet'),
      }),
    );

    expect(result.status).toBe('PENDING_REFERENCE');
    expect(result.balance).toBe('100.00');

    const [row] = await query<{ status: string; attempts: number; next_attempt_at: Date | null }>(
      context,
      'SELECT status, attempts, next_attempt_at FROM wager_transactions WHERE id = ?',
      [result.transactionId],
    );
    expect(row.status).toBe('PENDING_REFERENCE');
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).not.toBeNull();
  });

  it('refunds a BET once and rejects a second refund of the same BET', async () => {
    const wallet = await createWallet('100.00');
    const betExternal = unique('bet');
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

    const refund = await context.submit.execute(
      makeCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'REFUND',
        amount: '10.00',
        referenceExternalTransactionId: betExternal,
      }),
    );
    expect(refund.status).toBe('PROCESSED');
    expect(refund.balance).toBe('100.00');

    const duplicate = await context.submit.execute(
      makeCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'REFUND',
        amount: '10.00',
        referenceExternalTransactionId: betExternal,
      }),
    );
    expect(duplicate.status).toBe('REJECTED');
    expect(duplicate.failureCode).toBe('ALREADY_REVERSED');
    expect(duplicate.balance).toBe('100.00');
  });

  it('rejects invalid reference kind, amount and round mismatches', async () => {
    const wallet = await createWallet('100.00');
    const winExternal = unique('win-ref');
    await context.submit.execute(
      makeCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'WIN',
        amount: '5.00',
        roundId: 'round-ref',
        externalTransactionId: winExternal,
      }),
    );

    const wrongKind = await context.submit.execute(
      makeCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'REFUND',
        amount: '5.00',
        roundId: 'round-ref',
        referenceExternalTransactionId: winExternal,
      }),
    );
    expect(wrongKind.failureCode).toBe('REFERENCE_KIND_INVALID');

    const betExternal = unique('bet-ref');
    await context.submit.execute(
      makeCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'BET',
        amount: '10.00',
        roundId: 'round-ref',
        externalTransactionId: betExternal,
      }),
    );

    const wrongAmount = await context.submit.execute(
      makeCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'REFUND',
        amount: '11.00',
        roundId: 'round-ref',
        referenceExternalTransactionId: betExternal,
      }),
    );
    expect(wrongAmount.failureCode).toBe('AMOUNT_MISMATCH');

    const wrongRound = await context.submit.execute(
      makeCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'REFUND',
        amount: '10.00',
        roundId: 'another-round',
        referenceExternalTransactionId: betExternal,
      }),
    );
    expect(wrongRound.failureCode).toBe('REFERENCE_MISMATCH');
  });
});
