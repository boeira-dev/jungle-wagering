import { EntitySchema } from '@mikro-orm/core';
import {
  InboxMessageEntity,
  OutboxMessageEntity,
  WagerTransactionEntity,
  WalletEntity,
  WalletLedgerEntryEntity,
} from './models';

export const WalletSchema = new EntitySchema<WalletEntity>({
  class: WalletEntity,
  tableName: 'wallets',
  properties: {
    id: { type: 'string', columnType: 'uuid', primary: true },
    playerId: { type: 'string', columnType: 'varchar(255)', fieldName: 'player_id' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { type: 'string', columnType: 'numeric(19,2)' },
    version: { type: 'number', columnType: 'int' },
    createdAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'created_at' },
    updatedAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'updated_at' },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionEntity>({
  class: WagerTransactionEntity,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'string', columnType: 'uuid', primary: true },
    providerId: { type: 'string', columnType: 'varchar(255)', fieldName: 'provider_id' },
    externalTransactionId: {
      type: 'string',
      columnType: 'varchar(255)',
      fieldName: 'external_transaction_id',
    },
    idempotencyKey: { type: 'string', columnType: 'varchar(512)', fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', columnType: 'char(64)', fieldName: 'payload_hash' },
    walletId: { type: 'string', columnType: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'string', columnType: 'varchar(255)', fieldName: 'player_id' },
    roundId: { type: 'string', columnType: 'varchar(255)', fieldName: 'round_id', nullable: true },
    gameId: { type: 'string', columnType: 'varchar(255)', fieldName: 'game_id', nullable: true },
    kind: { type: 'string', columnType: 'varchar(16)' },
    amount: { type: 'string', columnType: 'numeric(19,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: {
      type: 'string',
      columnType: 'varchar(255)',
      fieldName: 'reference_external_transaction_id',
      nullable: true,
    },
    referenceTransactionId: {
      type: 'string',
      columnType: 'uuid',
      fieldName: 'reference_transaction_id',
      nullable: true,
    },
    status: { type: 'string', columnType: 'varchar(24)' },
    failureCode: {
      type: 'string',
      columnType: 'varchar(64)',
      fieldName: 'failure_code',
      nullable: true,
    },
    attempts: { type: 'number', columnType: 'int' },
    nextAttemptAt: {
      type: 'Date',
      columnType: 'timestamptz',
      fieldName: 'next_attempt_at',
      nullable: true,
    },
    balanceAfter: {
      type: 'string',
      columnType: 'numeric(19,2)',
      fieldName: 'balance_after',
      nullable: true,
    },
    processedAt: {
      type: 'Date',
      columnType: 'timestamptz',
      fieldName: 'processed_at',
      nullable: true,
    },
    createdAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'created_at' },
  },
});

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryEntity>({
  class: WalletLedgerEntryEntity,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'string', columnType: 'uuid', primary: true },
    walletId: { type: 'string', columnType: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'string', columnType: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string', columnType: 'varchar(8)' },
    amount: { type: 'string', columnType: 'numeric(19,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: {
      type: 'string',
      columnType: 'numeric(19,2)',
      fieldName: 'balance_before',
    },
    balanceAfter: { type: 'string', columnType: 'numeric(19,2)', fieldName: 'balance_after' },
    createdAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'created_at' },
  },
});

export const InboxMessageSchema = new EntitySchema<InboxMessageEntity>({
  class: InboxMessageEntity,
  tableName: 'inbox_messages',
  properties: {
    consumerName: {
      type: 'string',
      columnType: 'varchar(128)',
      fieldName: 'consumer_name',
      primary: true,
    },
    messageId: { type: 'string', columnType: 'varchar(255)', fieldName: 'message_id', primary: true },
    payloadHash: { type: 'string', columnType: 'char(64)', fieldName: 'payload_hash' },
    receivedAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'received_at' },
    processedAt: {
      type: 'Date',
      columnType: 'timestamptz',
      fieldName: 'processed_at',
      nullable: true,
    },
  },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageEntity>({
  class: OutboxMessageEntity,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'string', columnType: 'uuid', primary: true },
    aggregateId: { type: 'string', columnType: 'varchar(255)', fieldName: 'aggregate_id' },
    eventType: { type: 'string', columnType: 'varchar(128)', fieldName: 'event_type' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'occurred_at' },
    attempts: { type: 'number', columnType: 'int' },
    nextAttemptAt: {
      type: 'Date',
      columnType: 'timestamptz',
      fieldName: 'next_attempt_at',
      nullable: true,
    },
    publishedAt: {
      type: 'Date',
      columnType: 'timestamptz',
      fieldName: 'published_at',
      nullable: true,
    },
  },
});

export const ALL_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
