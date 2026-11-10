import { describe, expect, it } from 'bun:test';
import { WagerTransaction, type CreateWagerTransactionParams } from '../../src/domain/wager-transaction';
import { Money } from '../../src/domain/money';
import { InvalidKindError, InvalidReferenceError, InvalidTransactionStateError } from '../../src/domain/errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function createTx(overrides: Partial<CreateWagerTransactionParams> = {}): WagerTransaction {
  return WagerTransaction.create({
    providerId: 'provider-1',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'key-1',
    payloadHash: 'h'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: brl('10.00'),
    ...overrides,
  });
}

describe('WagerTransaction', () => {
  it('creates a PENDING transaction with zero attempts', () => {
    const tx = createTx();
    expect(tx.status).toBe('PENDING');
    expect(tx.attempts).toBe(0);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.balanceAfter).toBeNull();
    expect(tx.processedAt).toBeNull();
  });

  it('rejects invalid kind', () => {
    expect(() => createTx({ kind: 'NOPE' as never })).toThrow(InvalidKindError);
  });

  it('requires referenceExternalTransactionId for REFUND/ROLLBACK', () => {
    expect(() => createTx({ kind: 'REFUND' })).toThrow(InvalidReferenceError);
    expect(() => createTx({ kind: 'ROLLBACK' })).toThrow(InvalidReferenceError);
    expect(createTx({ kind: 'REFUND', referenceExternalTransactionId: 'ref-1' }).requiresReference()).toBe(
      true,
    );
  });

  it('computes affectsBalance (LOSS does not)', () => {
    expect(createTx({ kind: 'BET' }).affectsBalance()).toBe(true);
    expect(createTx({ kind: 'WIN' }).affectsBalance()).toBe(true);
    expect(createTx({ kind: 'REFUND', referenceExternalTransactionId: 'r' }).affectsBalance()).toBe(true);
    expect(createTx({ kind: 'LOSS' }).affectsBalance()).toBe(false);
    expect(createTx({ kind: 'OPENING', externalTransactionId: 'opening-1' }).affectsBalance()).toBe(true);
  });

  it('maps ledger direction for each kind', () => {
    expect(createTx({ kind: 'BET' }).ledgerDirectionFor()).toBe('DEBIT');
    expect(createTx({ kind: 'WIN' }).ledgerDirectionFor()).toBe('CREDIT');
    expect(createTx({ kind: 'LOSS' }).ledgerDirectionFor()).toBeNull();
    expect(createTx({ kind: 'OPENING', externalTransactionId: 'opening-1' }).ledgerDirectionFor()).toBe(
      'CREDIT',
    );
    expect(createTx({ kind: 'REFUND', referenceExternalTransactionId: 'r' }).ledgerDirectionFor()).toBe(
      'CREDIT',
    );
  });

  it('ROLLBACK inverts the referenced ledger direction', () => {
    const bet = createTx({ kind: 'BET' });
    const win = createTx({ kind: 'WIN', externalTransactionId: 'win-1' });
    const refund = createTx({
      kind: 'REFUND',
      externalTransactionId: 'refund-1',
      referenceExternalTransactionId: 'bet-1',
    });
    const rollback = createTx({ kind: 'ROLLBACK', referenceExternalTransactionId: 'x' });
    expect(rollback.ledgerDirectionFor(bet)).toBe('CREDIT');
    expect(rollback.ledgerDirectionFor(win)).toBe('DEBIT');
    expect(rollback.ledgerDirectionFor(refund)).toBe('DEBIT');
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidReferenceError);
  });

  it('supports PENDING -> PROCESSED and PENDING_REFERENCE -> PROCESSED', () => {
    const direct = createTx();
    const at = new Date('2026-01-01T00:00:00Z');
    direct.markProcessed(brl('90.00'), at);
    expect(direct.status).toBe('PROCESSED');
    expect(direct.balanceAfter?.amount).toBe('90.00');
    expect(direct.processedAt).toBe(at);

    const ref = createTx({ kind: 'REFUND', referenceExternalTransactionId: 'bet-1', externalTransactionId: 'refund-1' });
    ref.linkReference('tx-bet');
    ref.markPendingReference(at, new Date(at.getTime() + 5000));
    expect(ref.status).toBe('PENDING_REFERENCE');
    ref.markProcessed(brl('110.00'), at);
    expect(ref.status).toBe('PROCESSED');
  });

  it('supports PENDING -> PENDING_REFERENCE, REJECTED and FAILED', () => {
    const pending = createTx({ kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1' });
    pending.markPendingReference(new Date(), new Date(Date.now() + 5000));
    expect(pending.status).toBe('PENDING_REFERENCE');
    pending.reject('REFERENCE_NOT_FOUND_EXPIRED', new Date());
    expect(pending.status).toBe('REJECTED');
    expect(pending.failureCode).toBe('REFERENCE_NOT_FOUND_EXPIRED');

    const rejected = createTx();
    rejected.reject('INSUFFICIENT_FUNDS', new Date());
    expect(rejected.status).toBe('REJECTED');

    const failed = createTx();
    failed.fail('INFRASTRUCTURE_PERMANENT_ERROR', new Date());
    expect(failed.status).toBe('FAILED');
  });

  it('terminal states never transition again', () => {
    const processed = createTx();
    processed.markProcessed(brl('90.00'), new Date());
    expect(() => processed.markProcessed(brl('90.00'), new Date())).toThrow(InvalidTransactionStateError);
    expect(() => processed.reject('INSUFFICIENT_FUNDS', new Date())).toThrow(InvalidTransactionStateError);
    expect(() => processed.markPendingReference(new Date(), new Date())).toThrow(
      InvalidTransactionStateError,
    );

    const rejected = createTx();
    rejected.reject('INSUFFICIENT_FUNDS', new Date());
    expect(() => rejected.fail('INFRASTRUCTURE_PERMANENT_ERROR', new Date())).toThrow(
      InvalidTransactionStateError,
    );
  });

  it('cannot mark a reversal processed without a linked reference', () => {
    const refund = createTx({ kind: 'REFUND', referenceExternalTransactionId: 'bet-1' });
    expect(() => refund.markProcessed(brl('1.00'), new Date())).toThrow(InvalidReferenceError);
  });

  it('only reversals may link references, and only while non-terminal', () => {
    const bet = createTx();
    expect(() => bet.linkReference('x')).toThrow(InvalidReferenceError);

    const rollback = createTx({ kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1' });
    rollback.linkReference('tx-bet');
    rollback.markProcessed(brl('5.00'), new Date());
    expect(() => rollback.linkReference('tx-other')).toThrow(InvalidTransactionStateError);
  });

  it('payload matching is hash-based', () => {
    const tx = createTx({ payloadHash: 'a'.repeat(64) });
    expect(tx.matchesPayload('a'.repeat(64))).toBe(true);
    expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
  });

  it('reference retry scheduling increments attempts and sets next attempt', () => {
    const tx = createTx({ kind: 'REFUND', referenceExternalTransactionId: 'bet-1' });
    const now = new Date('2026-01-01T00:00:00Z');
    tx.markPendingReference(now, new Date(now.getTime() + 5000));
    expect(tx.attempts).toBe(1);
    tx.scheduleReferenceRetry(now, new Date(now.getTime() + 10000));
    expect(tx.attempts).toBe(2);
    expect(tx.nextAttemptAt?.getTime()).toBe(now.getTime() + 10000);
    expect(() => createTx().scheduleReferenceRetry(now, now)).toThrow(InvalidTransactionStateError);
  });
});
