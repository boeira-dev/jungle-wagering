import { randomUUID } from 'node:crypto';
import type { FailureCode, LedgerDirection, TransactionKind } from './enums';
import type { MoneyProps } from './money';

export interface EventParams<T> {
  eventId?: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string | null;
  occurredAt?: Date;
  data: T;
}

export interface EventEnvelope<T> {
  eventId: string;
  eventType: string;
  version: number;
  aggregateId: string;
  correlationId: string;
  causationId: string | null;
  occurredAt: string;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly occurredAt: Date;
  readonly data: T;

  protected constructor(params: EventParams<T>) {
    this.eventId = params.eventId ?? randomUUID();
    this.aggregateId = params.aggregateId;
    this.correlationId = params.correlationId;
    this.causationId = params.causationId ?? null;
    this.occurredAt = params.occurredAt ?? new Date();
    this.data = params.data;
  }

  toEnvelope(): EventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      version: this.version,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      data: this.data,
    };
  }

  toJSON(): EventEnvelope<T> {
    return this.toEnvelope();
  }
}

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  kind: TransactionKind;
  status: 'PROCESSED';
  money: MoneyProps;
  balanceAfter: MoneyProps;
}

export class WagerTransactionProcessedEvent extends IntegrationEvent<WagerTransactionProcessedData> {
  override readonly eventType = 'WagerTransactionProcessed';
  override readonly version = 1;
  constructor(params: EventParams<WagerTransactionProcessedData>) {
    super(params);
  }
}

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  kind: TransactionKind;
  status: 'REJECTED' | 'FAILED';
  failureCode: FailureCode;
  money: MoneyProps;
}

export class WagerTransactionRejectedEvent extends IntegrationEvent<WagerTransactionRejectedData> {
  override readonly eventType = 'WagerTransactionRejected';
  override readonly version = 1;
  constructor(params: EventParams<WagerTransactionRejectedData>) {
    super(params);
  }
}

export interface WalletBalanceChangedData {
  transactionId: string;
  walletId: string;
  playerId: string;
  currency: string;
  direction: LedgerDirection;
  previousBalance: string;
  balance: string;
  version: number;
}

export class WalletBalanceChangedEvent extends IntegrationEvent<WalletBalanceChangedData> {
  override readonly eventType = 'WalletBalanceChanged';
  override readonly version = 1;
  constructor(params: EventParams<WalletBalanceChangedData>) {
    super(params);
  }
}

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReferenceEvent extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  override readonly eventType = 'WagerTransactionPendingReference';
  override readonly version = 1;
  constructor(params: EventParams<WagerTransactionPendingReferenceData>) {
    super(params);
  }
}
