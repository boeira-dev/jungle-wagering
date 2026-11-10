import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  isExternalTransactionKind,
  type ExternalTransactionKind,
  type FailureCode,
  type TransactionStatus,
} from '../../domain/enums';
import {
  IdempotencyConflictError,
  InvalidKindError,
} from '../../domain/errors';
import type { IntegrationEvent } from '../../domain/events';
import { Money, type MoneyProps } from '../../domain/money';
import { computePayloadHash } from '../../domain/payload-hash';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { Wallet } from '../../domain/wallet';
import { WagerTransaction } from '../../domain/wager-transaction';
import { config } from '../../config';
import { DatabaseService } from '../../infrastructure/database/database.service';
import {
  InboxMessageEntity,
  WagerTransactionEntity,
  WalletEntity,
} from '../../infrastructure/persistence/entities/models';
import {
  applyTxToEntity,
  applyWalletToEntity,
  ledgerToEntity,
  txFromEntity,
  walletFromEntity,
} from '../../infrastructure/persistence/mappers';
import { MetricsService } from '../../observability/metrics.service';
import {
  persistEvents,
  transactionPendingReferenceEvent,
  transactionProcessedEvent,
  transactionRejectedEvent,
  walletBalanceChangedEvent,
} from '../events/event-outbox';

export interface SubmitWagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId?: string | null;
  gameId?: string | null;
  kind: ExternalTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | null;
  source: 'http' | 'sqs';
  correlationId?: string;
  messageId?: string;
  consumerName?: string;
}

export interface SubmitWagerResult {
  transactionId: string;
  status: TransactionStatus;
  balance: string | null;
  failureCode: FailureCode | null;
  idempotentReplay: boolean;
  walletId: string;
}

interface TransactionRow {
  id: string;
}

interface PendingReferenceRow {
  id: string;
}

const INSERT_TRANSACTION = `
  INSERT INTO wager_transactions (
    id, provider_id, external_transaction_id, idempotency_key, payload_hash,
    wallet_id, player_id, round_id, game_id, kind, amount, currency,
    reference_external_transaction_id, reference_transaction_id, status,
    failure_code, attempts, next_attempt_at, balance_after, processed_at, created_at
  ) VALUES (
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?, ?, ?, ?
  )
  ON CONFLICT DO NOTHING
  RETURNING id
`;

const SELECT_DUE_PENDING_REFERENCE = `
  SELECT id
  FROM wager_transactions
  WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= ?
  ORDER BY next_attempt_at, id
  LIMIT 1
  FOR UPDATE SKIP LOCKED
`;

@Injectable()
export class SubmitWagerUseCase {
  constructor(
    private readonly database: DatabaseService,
    private readonly metrics: MetricsService,
  ) {}

  async execute(command: SubmitWagerCommand): Promise<SubmitWagerResult> {
    const startedAt = Date.now();
    try {
      const result = await this.run(command);
      if (result.idempotentReplay) {
        this.metrics.recordReplay();
      } else {
        this.metrics.recordTransaction(result.status);
      }
      return result;
    } finally {
      this.metrics.observeProcessing((Date.now() - startedAt) / 1000);
    }
  }

  private async run(command: SubmitWagerCommand): Promise<SubmitWagerResult> {
    if (!isExternalTransactionKind(command.kind)) {
      throw new InvalidKindError(`Kind ${command.kind} is not accepted from external sources`);
    }
    const money = Money.from(command.money);
    const payloadHash = computePayloadHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId ?? null,
      gameId: command.gameId ?? null,
      kind: command.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: command.referenceExternalTransactionId ?? null,
    });
    const now = new Date();
    const correlationId = command.correlationId?.trim() || command.idempotencyKey;
    const transaction = WagerTransaction.create({
      id: randomUUID(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId ?? null,
      gameId: command.gameId ?? null,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId ?? null,
      now,
    });

    const em = this.database.fork();
    return em.transactional(async (trx) => {
      const inboxResult = await this.handleInbox(trx, command, payloadHash, now);
      if (inboxResult) return inboxResult;

      const inserted = await this.insertTransaction(trx, transaction);
      if (!inserted) {
        const replay = await this.replay(trx, command, payloadHash);
        await this.completeInbox(trx, command, now);
        return replay;
      }

      const result = await this.process(trx, transaction, correlationId, now);
      await this.completeInbox(trx, command, now);
      await trx.flush();
      return result;
    });
  }

  private async process(
    trx: EntityManager,
    transaction: WagerTransaction,
    correlationId: string,
    now: Date,
  ): Promise<SubmitWagerResult> {
    const entity = await trx.findOneOrFail(WagerTransactionEntity, { id: transaction.id });
    const walletEntity = await trx.findOne(
      WalletEntity,
      { id: transaction.walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );

    if (!walletEntity) {
      transaction.reject('WALLET_NOT_FOUND', now);
      applyTxToEntity(transaction, entity);
      persistEvents(trx, [transactionRejectedEvent(transaction, correlationId, now)]);
      return this.result(transaction, false);
    }

    const wallet = walletFromEntity(walletEntity);
    if (wallet.playerId !== transaction.playerId) {
      return this.reject(trx, transaction, entity, wallet, 'PLAYER_MISMATCH', correlationId, now);
    }
    if (wallet.currency !== transaction.money.currency) {
      return this.reject(trx, transaction, entity, wallet, 'CURRENCY_MISMATCH', correlationId, now);
    }

    const previousBalance = wallet.balance;
    let reference: WagerTransaction | undefined;

    if (transaction.requiresReference()) {
      const referenceEntity = await trx.findOne(
        WagerTransactionEntity,
        {
          providerId: transaction.providerId,
          externalTransactionId: transaction.referenceExternalTransactionId ?? '',
        },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      if (!referenceEntity) {
        const nextAttemptAt = this.nextReferenceAttempt(now, transaction.attempts);
        if (transaction.status === 'PENDING_REFERENCE') {
          transaction.scheduleReferenceRetry(now, nextAttemptAt, wallet.balance);
        } else {
          transaction.markPendingReference(now, nextAttemptAt, wallet.balance);
        }
        applyTxToEntity(transaction, entity);
        persistEvents(trx, [transactionPendingReferenceEvent(transaction, correlationId, now)]);
        return this.result(transaction, false);
      }

      reference = txFromEntity(referenceEntity);
      const failure = this.validateReference(transaction, reference);
      if (failure) {
        transaction.linkReference(reference.id);
        return this.reject(trx, transaction, entity, wallet, failure, correlationId, now);
      }

      const existingReversal = await trx.findOne(WagerTransactionEntity, {
        referenceTransactionId: reference.id,
        kind: transaction.kind,
        status: 'PROCESSED',
      });
      if (existingReversal) {
        transaction.linkReference(reference.id);
        return this.reject(trx, transaction, entity, wallet, 'ALREADY_REVERSED', correlationId, now);
      }

      transaction.linkReference(reference.id);
    }

    const direction = transaction.ledgerDirectionFor(reference);
    let ledger: WalletLedgerEntry | null = null;
    let failure: FailureCode | null = null;

    if (transaction.kind === 'LOSS') {
      transaction.markProcessed(wallet.balance, now);
    } else if (direction === 'DEBIT') {
      if (wallet.balance.isLessThan(transaction.money)) {
        failure = transaction.kind === 'BET' ? 'INSUFFICIENT_FUNDS' : 'REVERSAL_WOULD_OVERDRAW';
      } else {
        ledger = wallet.debit(transaction.money, transaction.id, now);
        transaction.markProcessed(wallet.balance, now);
      }
    } else {
      ledger = wallet.credit(transaction.money, transaction.id, now);
      transaction.markProcessed(wallet.balance, now);
    }

    if (failure) {
      return this.reject(trx, transaction, entity, wallet, failure, correlationId, now);
    }

    applyWalletToEntity(wallet, walletEntity);
    applyTxToEntity(transaction, entity);

    const events: IntegrationEvent<unknown>[] = [
      transactionProcessedEvent(
        transaction,
        transaction.balanceAfter ?? wallet.balance,
        correlationId,
        now,
      ),
    ];
    if (ledger && !wallet.balance.equals(previousBalance)) {
      events.push(
        walletBalanceChangedEvent(
          transaction,
          wallet,
          ledger,
          previousBalance,
          correlationId,
          now,
        ),
      );
    }
    if (ledger) trx.persist(ledgerToEntity(ledger));
    persistEvents(trx, events);

    return this.result(transaction, false);
  }

  private reject(
    trx: EntityManager,
    transaction: WagerTransaction,
    entity: WagerTransactionEntity,
    wallet: Wallet,
    failureCode: FailureCode,
    correlationId: string,
    now: Date,
  ): SubmitWagerResult {
    const observed =
      wallet.balance.currency === transaction.money.currency ? wallet.balance : undefined;
    transaction.reject(failureCode, now, observed);
    applyTxToEntity(transaction, entity);
    persistEvents(trx, [transactionRejectedEvent(transaction, correlationId, now)]);
    return this.result(transaction, false);
  }

  private validateReference(
    transaction: WagerTransaction,
    reference: WagerTransaction,
  ): FailureCode | null {
    if (reference.status !== 'PROCESSED') return 'REFERENCE_NOT_PROCESSED';
    if (reference.providerId !== transaction.providerId) return 'REFERENCE_MISMATCH';
    const allowedKinds =
      transaction.kind === 'REFUND' ? ['BET'] : ['BET', 'WIN', 'REFUND'];
    if (!allowedKinds.includes(reference.kind)) return 'REFERENCE_KIND_INVALID';
    if (reference.playerId !== transaction.playerId) return 'REFERENCE_MISMATCH';
    if (reference.walletId !== transaction.walletId) return 'REFERENCE_MISMATCH';
    if (reference.money.currency !== transaction.money.currency) return 'CURRENCY_MISMATCH';
    if ((reference.roundId ?? null) !== (transaction.roundId ?? null)) {
      return 'REFERENCE_MISMATCH';
    }
    if (!reference.money.equals(transaction.money)) return 'AMOUNT_MISMATCH';
    return null;
  }

  private async insertTransaction(
    trx: EntityManager,
    transaction: WagerTransaction,
  ): Promise<boolean> {
    const rows = (await trx.execute(INSERT_TRANSACTION, [
      transaction.id,
      transaction.providerId,
      transaction.externalTransactionId,
      transaction.idempotencyKey,
      transaction.payloadHash,
      transaction.walletId,
      transaction.playerId,
      transaction.roundId,
      transaction.gameId,
      transaction.kind,
      transaction.money.amount,
      transaction.money.currency,
      transaction.referenceExternalTransactionId,
      transaction.referenceTransactionId,
      transaction.status,
      transaction.failureCode,
      transaction.attempts,
      transaction.nextAttemptAt,
      transaction.balanceAfter?.amount ?? null,
      transaction.processedAt,
      transaction.createdAt,
    ])) as TransactionRow[];
    return rows.length > 0;
  }

  private async replay(
    trx: EntityManager,
    command: SubmitWagerCommand,
    payloadHash: string,
  ): Promise<SubmitWagerResult> {
    const byKey = await trx.findOne(WagerTransactionEntity, {
      idempotencyKey: command.idempotencyKey,
    });
    const entity =
      byKey ??
      (await trx.findOne(WagerTransactionEntity, {
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
      }));
    if (!entity) throw new IdempotencyConflictError();
    const transaction = txFromEntity(entity);
    if (!transaction.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError();
    }
    return this.result(transaction, true);
  }

  private async handleInbox(
    trx: EntityManager,
    command: SubmitWagerCommand,
    payloadHash: string,
    now: Date,
  ): Promise<SubmitWagerResult | null> {
    if (command.source !== 'sqs' || !command.messageId || !command.consumerName) return null;

    const rows = (await trx.execute(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING consumer_name`,
      [command.consumerName, command.messageId, payloadHash, now],
    )) as { consumer_name: string }[];
    if (rows.length > 0) return null;

    const existing = await trx.findOne(InboxMessageEntity, {
      consumerName: command.consumerName,
      messageId: command.messageId,
    });
    if (existing?.processedAt) {
      return this.replay(trx, command, payloadHash);
    }
    return null;
  }

  private async completeInbox(
    trx: EntityManager,
    command: SubmitWagerCommand,
    now: Date,
  ): Promise<void> {
    if (command.source !== 'sqs' || !command.messageId || !command.consumerName) return;
    await trx.execute(
      `UPDATE inbox_messages
       SET processed_at = COALESCE(processed_at, ?)
       WHERE consumer_name = ? AND message_id = ?`,
      [now, command.consumerName, command.messageId],
    );
  }

  private result(transaction: WagerTransaction, idempotentReplay: boolean): SubmitWagerResult {
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: transaction.balanceAfter?.amount ?? null,
      failureCode: transaction.failureCode,
      idempotentReplay,
      walletId: transaction.walletId,
    };
  }

  /**
   * Processes at most one due PENDING_REFERENCE transaction. Selection and
   * processing share one transaction with FOR UPDATE SKIP LOCKED, so several
   * instances can drain the queue concurrently without double processing.
   *
   * @returns true when a row was claimed (processed, rescheduled or expired)
   */
  async processNextPendingReference(): Promise<boolean> {
    const em = this.database.fork();
    const now = new Date();

    return em.transactional(async (trx) => {
      const rows = (await trx.execute(SELECT_DUE_PENDING_REFERENCE, [
        now,
      ])) as PendingReferenceRow[];
      if (rows.length === 0) return false;

      const entity = await trx.findOneOrFail(WagerTransactionEntity, { id: rows[0].id });
      const transaction = txFromEntity(entity);
      const ageMs = now.getTime() - transaction.createdAt.getTime();

      if (
        transaction.attempts >= config.referenceWorker.maxAttempts ||
        ageMs >= config.referenceWorker.ttlMs
      ) {
        const walletEntity = await trx.findOne(WalletEntity, { id: transaction.walletId });
        transaction.reject(
          'REFERENCE_NOT_FOUND_EXPIRED',
          now,
          walletEntity ? walletFromEntity(walletEntity).balance : undefined,
        );
        applyTxToEntity(transaction, entity);
        persistEvents(trx, [transactionRejectedEvent(transaction, transaction.id, now)]);
        await trx.flush();
        this.metrics.recordTransaction('REJECTED');
        return true;
      }

      const result = await this.process(trx, transaction, transaction.id, now);
      await trx.flush();

      if (result.status === 'PENDING_REFERENCE') {
        this.metrics.recordRetry('reference');
      } else {
        this.metrics.recordTransaction(result.status);
      }
      return true;
    });
  }

  private nextReferenceAttempt(now: Date, attempts: number): Date {
    const { baseDelayMs, factor, ttlMs } = config.referenceWorker;
    const delayMs = Math.min(baseDelayMs * Math.pow(factor, Math.max(attempts, 0)), ttlMs);
    return new Date(now.getTime() + delayMs);
  }
}
