import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
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

describe('submit concurrency', () => {
  it('serializes two 80.00 bets against a 100.00 wallet: one processed, one rejected', async () => {
    const wallet = await createWallet('100.00');

    const [first, second] = await Promise.all([
      context.submit.execute(
        makeCommand({ walletId: wallet.id, playerId: wallet.playerId, amount: '80.00' }),
      ),
      context.submit.execute(
        makeCommand({ walletId: wallet.id, playerId: wallet.playerId, amount: '80.00' }),
      ),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);

    const processed = first.status === 'PROCESSED' ? first : second;
    const rejected = first.status === 'REJECTED' ? first : second;
    expect(processed.balance).toBe('20.00');
    expect(rejected.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(rejected.balance).toBe('20.00');

    const [stored] = await query<{ balance: string; version: number }>(
      context,
      'SELECT balance, version FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(stored.balance).toBe('20.00');
    expect(stored.version).toBe(2);

    const ledger = await query<{ direction: string }>(
      context,
      'SELECT direction FROM wallet_ledger_entries WHERE wallet_id = ?',
      [wallet.id],
    );
    expect(ledger.filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);
    expect(ledger.filter((entry) => entry.direction === 'CREDIT')).toHaveLength(1);
  });

  it(
    'does not overspend under 50 concurrent 10.00 bets: exactly 10 processed',
    async () => {
    const wallet = await createWallet('100.00');

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        context.submit.execute(
          makeCommand({ walletId: wallet.id, playerId: wallet.playerId, amount: '10.00' }),
        ),
      ),
    );

    const processed = results.filter((result) => result.status === 'PROCESSED');
    const rejected = results.filter((result) => result.status === 'REJECTED');

    expect(processed).toHaveLength(10);
    expect(rejected).toHaveLength(40);
    expect(rejected.every((result) => result.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect(processed.every((result) => Number(result.balance) >= 0)).toBe(true);
    expect(rejected.every((result) => Number(result.balance) >= 0)).toBe(true);

    const [stored] = await query<{ balance: string; version: number }>(
      context,
      'SELECT balance, version FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(stored.balance).toBe('0.00');
    expect(stored.version).toBe(11);

    const ledger = await query<{ direction: string; amount: string; balance_after: string }>(
      context,
      'SELECT direction, amount, balance_after FROM wallet_ledger_entries WHERE wallet_id = ?',
      [wallet.id],
    );
    const debits = ledger.filter((entry) => entry.direction === 'DEBIT');
    expect(debits).toHaveLength(10);
    expect(debits.every((entry) => entry.amount === '10.00')).toBe(true);
    expect(ledger.every((entry) => Number(entry.balance_after) >= 0)).toBe(true);

    const transactions = await query<{ status: string }>(
      context,
      'SELECT status FROM wager_transactions WHERE wallet_id = ? AND kind = ?',
      [wallet.id, 'BET'],
    );
    expect(transactions.filter((tx) => tx.status === 'PROCESSED')).toHaveLength(10);
    expect(transactions.filter((tx) => tx.status === 'REJECTED')).toHaveLength(40);
    },
    30_000,
  );

  it(
    'deduplicates 10 concurrent submissions sharing one idempotency key',
    async () => {
      const wallet = await createWallet('100.00');
      const command = makeCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        amount: '10.00',
        externalTransactionId: unique('same-ext'),
        idempotencyKey: unique('same-key'),
      });

      const results = await Promise.all(
        Array.from({ length: 10 }, () => context.submit.execute(command)),
      );

      const transactionIds = new Set(results.map((result) => result.transactionId));
      expect(transactionIds.size).toBe(1);
      expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
      expect(results.filter((result) => result.idempotentReplay)).toHaveLength(9);
      expect(results.every((result) => result.balance === '90.00')).toBe(true);

      const [stored] = await query<{ balance: string; version: number }>(
        context,
        'SELECT balance, version FROM wallets WHERE id = ?',
        [wallet.id],
      );
      expect(stored).toEqual({ balance: '90.00', version: 2 });

      const [transactionId] = [...transactionIds];
      const ledger = await query(
        context,
        'SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = ?',
        [transactionId],
      );
      expect(ledger).toHaveLength(1);

      const transactions = await query(
        context,
        'SELECT 1 FROM wager_transactions WHERE wallet_id = ? AND kind = ?',
        [wallet.id, 'BET'],
      );
      expect(transactions).toHaveLength(1);
    },
    30_000,
  );
});
