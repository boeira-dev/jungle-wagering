import { createHash } from 'node:crypto';
import type { TransactionKind } from './enums';
import { Money, type MoneyProps } from './money';

export interface PayloadHashInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId?: string | null;
  gameId?: string | null;
  kind: TransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | null;
}

/**
 * Recursively serializes a value with object keys sorted. This is what makes
 * the hash independent of HTTP/JSON property order. Arrays keep their order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${parts.join(',')}}`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot canonicalize non-finite number');
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 over the canonical business payload only.
 * Transport metadata (headers, message ids, timestamps) are deliberately excluded.
 */
export function computePayloadHash(input: PayloadHashInput): string {
  const money = Money.from(input.money).toJSON();
  const payload = {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId ?? null,
    gameId: input.gameId ?? null,
    kind: input.kind,
    money,
    referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
  };
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}
