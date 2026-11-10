import { describe, expect, it } from 'bun:test';
import { canonicalJson, computePayloadHash, type PayloadHashInput } from '../../src/domain/payload-hash';
import { WagerTransaction } from '../../src/domain/wager-transaction';
import { Money } from '../../src/domain/money';

const base: PayloadHashInput = {
  providerId: 'provider-1',
  externalTransactionId: 'ext-1',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
  referenceExternalTransactionId: null,
};

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('normalizes null/undefined', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('computePayloadHash', () => {
  it('produces a 64-char hex sha256', () => {
    const hash = computePayloadHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is independent of property insertion order', () => {
    const reordered: PayloadHashInput = {
      referenceExternalTransactionId: null,
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'game-1',
      roundId: 'round-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      externalTransactionId: 'ext-1',
      providerId: 'provider-1',
    };
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(base));
  });

  it('normalizes the money scale before hashing', () => {
    const a = computePayloadHash({ ...base, money: { amount: '25', currency: 'BRL' } });
    const b = computePayloadHash({ ...base, money: { amount: '25.00', currency: 'BRL' } });
    expect(a).toBe(b);
  });

  it('changes when any business field changes', () => {
    const original = computePayloadHash(base);
    expect(computePayloadHash({ ...base, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(original);
    expect(computePayloadHash({ ...base, walletId: 'other' })).not.toBe(original);
    expect(computePayloadHash({ ...base, kind: 'WIN' })).not.toBe(original);
    expect(computePayloadHash({ ...base, referenceExternalTransactionId: 'x' })).not.toBe(original);
  });

  it('ignores transport metadata outside the business payload', () => {
    const withExtra = { ...base, correlationId: 'ignored', httpHeader: 'ignored' } as PayloadHashInput;
    expect(computePayloadHash(withExtra)).toBe(computePayloadHash(base));
  });

  it('detects idempotency key reuse with divergent payload', () => {
    const money = Money.from({ amount: '25.00', currency: 'BRL' });
    const tx = WagerTransaction.create({
      providerId: base.providerId,
      externalTransactionId: base.externalTransactionId,
      idempotencyKey: 'same-key',
      payloadHash: computePayloadHash(base),
      walletId: base.walletId,
      playerId: base.playerId,
      roundId: base.roundId,
      gameId: base.gameId,
      kind: 'BET',
      money,
    });
    const divergentHash = computePayloadHash({ ...base, money: { amount: '30.00', currency: 'BRL' } });
    expect(tx.matchesPayload(computePayloadHash(base))).toBe(true);
    expect(tx.matchesPayload(divergentHash)).toBe(false);
  });
});
