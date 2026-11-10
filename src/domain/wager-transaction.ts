import { randomUUID } from 'node:crypto';
import {
  CurrencyMismatchError,
  InvalidKindError,
  InvalidReferenceError,
  InvalidTransactionStateError,
} from './errors';
import {
  isTerminalStatus,
  isTransactionKind,
  type FailureCode,
  type LedgerDirection,
  type TransactionKind,
  type TransactionStatus,
} from './enums';
import { Money } from './money';

export interface WagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: TransactionKind;
  money: Money;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: TransactionStatus;
  failureCode: FailureCode | null;
  attempts: number;
  nextAttemptAt: Date | null;
  balanceAfter: Money | null;
  processedAt: Date | null;
  createdAt: Date;
}

export interface CreateWagerTransactionParams {
  id?: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId?: string | null;
  gameId?: string | null;
  kind: TransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | null;
  now?: Date;
}

const REQUIRED_TEXT: Array<keyof CreateWagerTransactionParams> = [
  'providerId',
  'externalTransactionId',
  'idempotencyKey',
  'payloadHash',
  'walletId',
  'playerId',
];

export class WagerTransaction {
  private constructor(private readonly props: WagerTransactionProps) {}

  static create(params: CreateWagerTransactionParams): WagerTransaction {
    if (!isTransactionKind(params.kind)) {
      throw new InvalidKindError(`Invalid transaction kind: ${String(params.kind)}`);
    }
    for (const field of REQUIRED_TEXT) {
      const value = params[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new InvalidKindError(`Field ${String(field)} is required`);
      }
    }

    const requiresReference = params.kind === 'REFUND' || params.kind === 'ROLLBACK';
    const referenceExternal = params.referenceExternalTransactionId?.trim() || null;
    if (requiresReference && !referenceExternal) {
      throw new InvalidReferenceError(`${params.kind} requires referenceExternalTransactionId`);
    }
    if (!requiresReference && referenceExternal) {
      throw new InvalidReferenceError(
        `Only REFUND and ROLLBACK may reference a transaction (got ${params.kind})`,
      );
    }

    return new WagerTransaction({
      id: params.id ?? randomUUID(),
      providerId: params.providerId.trim(),
      externalTransactionId: params.externalTransactionId.trim(),
      idempotencyKey: params.idempotencyKey.trim(),
      payloadHash: params.payloadHash,
      walletId: params.walletId,
      playerId: params.playerId.trim(),
      roundId: params.roundId ?? null,
      gameId: params.gameId ?? null,
      kind: params.kind,
      money: params.money,
      referenceExternalTransactionId: referenceExternal,
      referenceTransactionId: null,
      status: 'PENDING',
      failureCode: null,
      attempts: 0,
      nextAttemptAt: null,
      balanceAfter: null,
      processedAt: null,
      createdAt: params.now ?? new Date(),
    });
  }

  static rehydrate(props: WagerTransactionProps): WagerTransaction {
    return new WagerTransaction({ ...props });
  }

  isTerminal(): boolean {
    return isTerminalStatus(this.props.status);
  }

  affectsBalance(): boolean {
    return this.props.kind !== 'LOSS';
  }

  requiresReference(): boolean {
    return this.props.kind === 'REFUND' || this.props.kind === 'ROLLBACK';
  }

  matchesPayload(hash: string): boolean {
    return this.props.payloadHash === hash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | null {
    switch (this.props.kind) {
      case 'BET':
        return 'DEBIT';
      case 'WIN':
      case 'OPENING':
      case 'REFUND':
        return 'CREDIT';
      case 'LOSS':
        return null;
      case 'ROLLBACK': {
        if (!reference) {
          throw new InvalidReferenceError('ROLLBACK requires a reference transaction');
        }
        const referenceDirection = reference.ledgerDirectionFor();
        if (!referenceDirection) {
          throw new InvalidReferenceError('REFERENCE_NOT_PROCESSED');
        }
        return referenceDirection === 'DEBIT' ? 'CREDIT' : 'DEBIT';
      }
      default:
        return null;
    }
  }

  linkReference(referenceTransactionId: string): void {
    if (!this.requiresReference()) {
      throw new InvalidReferenceError('Only REFUND and ROLLBACK may reference a transaction');
    }
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.props.status, 'linkReference');
    }
    this.props.referenceTransactionId = referenceTransactionId;
  }

  markPendingReference(now: Date, nextAttemptAt: Date, balanceAfter?: Money): void {
    this.assertTransition('PENDING_REFERENCE');
    this.props.status = 'PENDING_REFERENCE';
    this.props.nextAttemptAt = nextAttemptAt;
    this.props.attempts += 1;
    this.props.processedAt = null;
    this.setObservedBalance(balanceAfter);
  }

  scheduleReferenceRetry(now: Date, nextAttemptAt: Date, balanceAfter?: Money): void {
    if (this.props.status !== 'PENDING_REFERENCE') {
      throw new InvalidTransactionStateError(this.props.status, 'PENDING_REFERENCE');
    }
    this.props.attempts += 1;
    this.props.nextAttemptAt = nextAttemptAt;
    this.setObservedBalance(balanceAfter);
  }

  markProcessed(balanceAfter: Money, now: Date): void {
    this.assertTransition('PROCESSED');
    if (this.requiresReference() && !this.props.referenceTransactionId) {
      throw new InvalidReferenceError('Reversal cannot be processed without a reference');
    }
    if (balanceAfter.currency !== this.props.money.currency) {
      throw new CurrencyMismatchError(balanceAfter.currency, this.props.money.currency);
    }
    this.props.status = 'PROCESSED';
    this.props.balanceAfter = balanceAfter;
    this.props.processedAt = now;
    this.props.nextAttemptAt = null;
    this.props.failureCode = null;
  }

  reject(code: FailureCode, now: Date, balanceAfter?: Money): void {
    this.assertTransition('REJECTED');
    this.props.status = 'REJECTED';
    this.props.failureCode = code;
    this.props.processedAt = now;
    this.props.nextAttemptAt = null;
    this.setObservedBalance(balanceAfter);
  }

  fail(code: FailureCode, now: Date, balanceAfter?: Money): void {
    this.assertTransition('FAILED');
    this.props.status = 'FAILED';
    this.props.failureCode = code;
    this.props.processedAt = now;
    this.props.nextAttemptAt = null;
    this.setObservedBalance(balanceAfter);
  }

  private setObservedBalance(balanceAfter?: Money): void {
    if (!balanceAfter) return;
    if (balanceAfter.currency !== this.props.money.currency) {
      throw new CurrencyMismatchError(balanceAfter.currency, this.props.money.currency);
    }
    this.props.balanceAfter = balanceAfter;
  }

  private assertTransition(target: TransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.props.status, target);
    }
    if (this.props.status === 'PENDING_REFERENCE' && target === 'PENDING_REFERENCE') {
      throw new InvalidTransactionStateError(this.props.status, target);
    }
  }

  get id(): string {
    return this.props.id;
  }
  get providerId(): string {
    return this.props.providerId;
  }
  get externalTransactionId(): string {
    return this.props.externalTransactionId;
  }
  get idempotencyKey(): string {
    return this.props.idempotencyKey;
  }
  get payloadHash(): string {
    return this.props.payloadHash;
  }
  get walletId(): string {
    return this.props.walletId;
  }
  get playerId(): string {
    return this.props.playerId;
  }
  get roundId(): string | null {
    return this.props.roundId;
  }
  get gameId(): string | null {
    return this.props.gameId;
  }
  get kind(): TransactionKind {
    return this.props.kind;
  }
  get money(): Money {
    return this.props.money;
  }
  get referenceExternalTransactionId(): string | null {
    return this.props.referenceExternalTransactionId;
  }
  get referenceTransactionId(): string | null {
    return this.props.referenceTransactionId;
  }
  get status(): TransactionStatus {
    return this.props.status;
  }
  get failureCode(): FailureCode | null {
    return this.props.failureCode;
  }
  get attempts(): number {
    return this.props.attempts;
  }
  get nextAttemptAt(): Date | null {
    return this.props.nextAttemptAt;
  }
  get balanceAfter(): Money | null {
    return this.props.balanceAfter;
  }
  get processedAt(): Date | null {
    return this.props.processedAt;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }

  toProps(): WagerTransactionProps {
    return { ...this.props };
  }
}
