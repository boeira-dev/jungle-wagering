import type { FailureCode, TransactionKind, TransactionStatus } from '../../domain/enums';
import type { IntegrationEvent } from '../../domain/events';
import { Money } from '../../domain/money';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { Wallet } from '../../domain/wallet';
import { WagerTransaction } from '../../domain/wager-transaction';
import {
  OutboxMessageEntity,
  WagerTransactionEntity,
  WalletEntity,
  WalletLedgerEntryEntity,
} from './entities/models';

export function walletFromEntity(entity: WalletEntity): Wallet {
  return Wallet.rehydrate({
    id: entity.id,
    playerId: entity.playerId,
    currency: entity.currency.trim(),
    balance: Money.rehydrate({ amount: entity.balance, currency: entity.currency.trim() }),
    version: entity.version,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  });
}

export function applyWalletToEntity(wallet: Wallet, entity: WalletEntity): void {
  entity.balance = wallet.balance.amount;
  entity.version = wallet.version;
  entity.updatedAt = wallet.updatedAt;
}

export function txFromEntity(entity: WagerTransactionEntity): WagerTransaction {
  const currency = entity.currency.trim();
  return WagerTransaction.rehydrate({
    id: entity.id,
    providerId: entity.providerId,
    externalTransactionId: entity.externalTransactionId,
    idempotencyKey: entity.idempotencyKey,
    payloadHash: entity.payloadHash.trim(),
    walletId: entity.walletId,
    playerId: entity.playerId,
    roundId: entity.roundId ?? null,
    gameId: entity.gameId ?? null,
    kind: entity.kind as TransactionKind,
    money: Money.rehydrate({ amount: entity.amount, currency }),
    referenceExternalTransactionId: entity.referenceExternalTransactionId ?? null,
    referenceTransactionId: entity.referenceTransactionId ?? null,
    status: entity.status as TransactionStatus,
    failureCode: (entity.failureCode as FailureCode | null | undefined) ?? null,
    attempts: entity.attempts,
    nextAttemptAt: entity.nextAttemptAt ?? null,
    balanceAfter: entity.balanceAfter
      ? Money.rehydrate({ amount: entity.balanceAfter, currency })
      : null,
    processedAt: entity.processedAt ?? null,
    createdAt: entity.createdAt,
  });
}

export function applyTxToEntity(tx: WagerTransaction, entity: WagerTransactionEntity): void {
  entity.status = tx.status;
  entity.failureCode = tx.failureCode;
  entity.referenceTransactionId = tx.referenceTransactionId;
  entity.attempts = tx.attempts;
  entity.nextAttemptAt = tx.nextAttemptAt;
  entity.balanceAfter = tx.balanceAfter?.amount ?? null;
  entity.processedAt = tx.processedAt;
}

export function txToEntity(tx: WagerTransaction): WagerTransactionEntity {
  const entity = new WagerTransactionEntity();
  entity.id = tx.id;
  entity.providerId = tx.providerId;
  entity.externalTransactionId = tx.externalTransactionId;
  entity.idempotencyKey = tx.idempotencyKey;
  entity.payloadHash = tx.payloadHash;
  entity.walletId = tx.walletId;
  entity.playerId = tx.playerId;
  entity.roundId = tx.roundId;
  entity.gameId = tx.gameId;
  entity.kind = tx.kind;
  entity.amount = tx.money.amount;
  entity.currency = tx.money.currency;
  entity.referenceExternalTransactionId = tx.referenceExternalTransactionId;
  entity.referenceTransactionId = tx.referenceTransactionId;
  entity.status = tx.status;
  entity.failureCode = tx.failureCode;
  entity.attempts = tx.attempts;
  entity.nextAttemptAt = tx.nextAttemptAt;
  entity.balanceAfter = tx.balanceAfter?.amount ?? null;
  entity.processedAt = tx.processedAt;
  entity.createdAt = tx.createdAt;
  return entity;
}

export function ledgerToEntity(entry: WalletLedgerEntry): WalletLedgerEntryEntity {
  const entity = new WalletLedgerEntryEntity();
  entity.id = entry.id;
  entity.walletId = entry.walletId;
  entity.transactionId = entry.transactionId;
  entity.direction = entry.direction;
  entity.amount = entry.money.amount;
  entity.currency = entry.money.currency;
  entity.balanceBefore = entry.balanceBefore.amount;
  entity.balanceAfter = entry.balanceAfter.amount;
  entity.createdAt = entry.createdAt;
  return entity;
}

export function outboxToEntity(event: IntegrationEvent<unknown>): OutboxMessageEntity {
  const entity = new OutboxMessageEntity();
  entity.id = event.eventId;
  entity.aggregateId = event.aggregateId;
  entity.eventType = event.eventType;
  entity.payload = event.toEnvelope() as unknown as Record<string, unknown>;
  entity.occurredAt = event.occurredAt;
  entity.attempts = 0;
  entity.nextAttemptAt = null;
  entity.publishedAt = null;
  return entity;
}
