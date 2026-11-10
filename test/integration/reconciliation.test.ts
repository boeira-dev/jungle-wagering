import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ReconciliationWorker } from '../../src/application/reconciliation/reconciliation.worker';
import {
  createTestContext,
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

describe('reconciliation', () => {
  it('reports a balance/ledger divergence and clears it after correction', async () => {
    const wallet = await context.wallets.create({
      playerId: unique('player'),
      currency: 'BRL',
      initialBalance: '100.00',
    });

    await query(context, 'UPDATE wallets SET balance = ? WHERE id = ?', ['101.00', wallet.id]);

    const worker = new ReconciliationWorker(context.database, context.metrics);
    const dirty = await worker.runOnce();

    expect(dirty.checked).toBeGreaterThanOrEqual(1);
    expect(dirty.divergences).toContain(wallet.id);
    expect(await context.metrics.render()).toMatch(/reconciliation_divergences_total [1-9]/);

    await query(context, 'UPDATE wallets SET balance = ? WHERE id = ?', ['100.00', wallet.id]);

    const clean = await worker.runOnce();
    expect(clean.divergences).not.toContain(wallet.id);
  });

  it('treats a zero-balance wallet without ledger entries as consistent', async () => {
    const wallet = await context.wallets.create({
      playerId: unique('player'),
      currency: 'BRL',
    });

    const worker = new ReconciliationWorker(context.database, context.metrics);
    const result = await worker.runOnce();
    expect(result.checked).toBeGreaterThanOrEqual(1);
    expect(result.divergences).not.toContain(wallet.id);
  });
});
