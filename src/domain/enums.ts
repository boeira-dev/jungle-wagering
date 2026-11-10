export const TRANSACTION_KINDS = [
  'OPENING',
  'BET',
  'WIN',
  'LOSS',
  'REFUND',
  'ROLLBACK',
] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

/** Kinds accepted from HTTP / SQS. OPENING is internal only. */
export const EXTERNAL_TRANSACTION_KINDS = [
  'BET',
  'WIN',
  'LOSS',
  'REFUND',
  'ROLLBACK',
] as const;
export type ExternalTransactionKind = (typeof EXTERNAL_TRANSACTION_KINDS)[number];

export const TRANSACTION_STATUSES = [
  'PENDING',
  'PENDING_REFERENCE',
  'PROCESSED',
  'REJECTED',
  'FAILED',
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const TERMINAL_STATUSES: readonly TransactionStatus[] = ['PROCESSED', 'REJECTED', 'FAILED'];

export const LEDGER_DIRECTIONS = ['DEBIT', 'CREDIT'] as const;
export type LedgerDirection = (typeof LEDGER_DIRECTIONS)[number];

export const FAILURE_CODES = [
  'INSUFFICIENT_FUNDS',
  'REVERSAL_WOULD_OVERDRAW',
  'REFERENCE_NOT_FOUND_EXPIRED',
  'REFERENCE_KIND_INVALID',
  'REFERENCE_MISMATCH',
  'AMOUNT_MISMATCH',
  'ALREADY_REVERSED',
  'REFERENCE_NOT_PROCESSED',
  'WALLET_NOT_FOUND',
  'PLAYER_MISMATCH',
  'CURRENCY_MISMATCH',
  'INFRASTRUCTURE_PERMANENT_ERROR',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export function isTransactionKind(value: string): value is TransactionKind {
  return (TRANSACTION_KINDS as readonly string[]).includes(value);
}

export function isExternalTransactionKind(value: string): value is ExternalTransactionKind {
  return (EXTERNAL_TRANSACTION_KINDS as readonly string[]).includes(value);
}

export function isTerminalStatus(status: TransactionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
