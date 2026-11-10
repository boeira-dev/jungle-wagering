import type { EntityManager } from '@mikro-orm/postgresql';
import type { LedgerDirection } from '../../domain/enums';
import {
  WalletBalanceChangedEvent,
  WagerTransactionPendingReferenceEvent,
  WagerTransactionProcessedEvent,
  WagerTransactionRejectedEvent,
  type IntegrationEvent,
} from '../../domain/events';
import type { Money } from '../../domain/money';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import type { Wallet } from '../../domain/wallet';
import type { WagerTransaction } from '../../domain/wager-transaction';
import { outboxToEntity } from '../../infrastructure/persistence/mappers';

function transactionBase(tx: WagerTransaction) {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    kind: tx.kind,
  };
}

export function transactionProcessedEvent(
  tx: WagerTransaction,
  balanceAfter: Money,
  correlationId: string,
  occurredAt: Date,
): WagerTransactionProcessedEvent {
  return new WagerTransactionProcessedEvent({
    aggregateId: tx.id,
    correlationId,
    causationId: tx.id,
    occurredAt,
    data: {
      ...transactionBase(tx),
      status: 'PROCESSED',
      money: tx.money.toJSON(),
      balanceAfter: balanceAfter.toJSON(),
    },
  });
}

export function walletBalanceChangedEvent(
  tx: WagerTransaction,
  wallet: Wallet,
  ledger: WalletLedgerEntry,
  previousBalance: Money,
  correlationId: string,
  occurredAt: Date,
): WalletBalanceChangedEvent {
  return new WalletBalanceChangedEvent({
    aggregateId: wallet.id,
    correlationId,
    causationId: tx.id,
    occurredAt,
    data: {
      transactionId: tx.id,
      walletId: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      direction: ledger.direction as LedgerDirection,
      previousBalance: previousBalance.amount,
      balance: wallet.balance.amount,
      version: wallet.version,
    },
  });
}

export function transactionRejectedEvent(
  tx: WagerTransaction,
  correlationId: string,
  occurredAt: Date,
): WagerTransactionRejectedEvent {
  return new WagerTransactionRejectedEvent({
    aggregateId: tx.id,
    correlationId,
    causationId: tx.id,
    occurredAt,
    data: {
      ...transactionBase(tx),
      status: tx.status === 'FAILED' ? 'FAILED' : 'REJECTED',
      failureCode: tx.failureCode ?? 'INFRASTRUCTURE_PERMANENT_ERROR',
      money: tx.money.toJSON(),
    },
  });
}

export function transactionPendingReferenceEvent(
  tx: WagerTransaction,
  correlationId: string,
  occurredAt: Date,
): WagerTransactionPendingReferenceEvent {
  return new WagerTransactionPendingReferenceEvent({
    aggregateId: tx.id,
    correlationId,
    causationId: tx.id,
    occurredAt,
    data: {
      ...transactionBase(tx),
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? '',
      attempts: tx.attempts,
      nextAttemptAt: (tx.nextAttemptAt ?? occurredAt).toISOString(),
    },
  });
}

export function persistEvents(
  em: EntityManager,
  events: IntegrationEvent<unknown>[],
): void {
  for (const event of events) {
    em.persist(outboxToEntity(event));
  }
}
