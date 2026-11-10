import { randomUUID } from 'node:crypto';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvalidWalletError,
} from './errors';
import { Money } from './money';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletProps {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWalletParams {
  id?: string;
  playerId: string;
  currency: string;
  initialBalance?: Money;
  now?: Date;
}

export class Wallet {
  private constructor(private readonly props: WalletProps) {}

  static create(params: CreateWalletParams): Wallet {
    if (!params.playerId?.trim()) {
      throw new InvalidWalletError('playerId is required');
    }
    const currency = params.currency?.trim().toUpperCase();
    if (!currency) {
      throw new InvalidWalletError('currency is required');
    }
    const initial = params.initialBalance ?? Money.zero(currency);
    if (initial.currency !== currency) {
      throw new CurrencyMismatchError(initial.currency, currency);
    }
    if (initial.isNegative()) {
      throw new InvalidMoneyError('Initial balance must not be negative');
    }
    const now = params.now ?? new Date();
    return new Wallet({
      id: params.id ?? randomUUID(),
      playerId: params.playerId.trim(),
      currency,
      balance: initial,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Rebuilds persisted state without revalidating creation contracts. */
  static rehydrate(props: WalletProps): Wallet {
    return new Wallet({ ...props });
  }

  debit(money: Money, transactionId: string, now: Date = new Date()): WalletLedgerEntry {
    this.assertCurrency(money.currency);
    if (money.isNegative()) throw new InvalidMoneyError('Debit amount must not be negative');
    if (this.props.balance.isLessThan(money)) {
      throw new InsufficientFundsError(this.props.balance.toString(), money.toString());
    }
    const before = this.props.balance;
    const after = before.subtract(money);
    this.applyBalance(after, now);
    return WalletLedgerEntry.create({
      walletId: this.props.id,
      transactionId,
      direction: 'DEBIT',
      money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: now,
    });
  }

  credit(money: Money, transactionId: string, now: Date = new Date()): WalletLedgerEntry {
    this.assertCurrency(money.currency);
    if (money.isNegative()) throw new InvalidMoneyError('Credit amount must not be negative');
    const before = this.props.balance;
    const after = before.add(money);
    this.applyBalance(after, now);
    return WalletLedgerEntry.create({
      walletId: this.props.id,
      transactionId,
      direction: 'CREDIT',
      money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: now,
    });
  }

  private applyBalance(after: Money, now: Date): void {
    const changed = !after.equals(this.props.balance);
    this.props.balance = after;
    this.props.updatedAt = now;
    if (changed) this.props.version += 1;
  }

  private assertCurrency(currency: string): void {
    if (this.props.currency !== currency) {
      throw new CurrencyMismatchError(this.props.currency, currency);
    }
  }

  get id(): string {
    return this.props.id;
  }

  get playerId(): string {
    return this.props.playerId;
  }

  get currency(): string {
    return this.props.currency;
  }

  get balance(): Money {
    return this.props.balance;
  }

  get version(): number {
    return this.props.version;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  toProps(): WalletProps {
    return { ...this.props };
  }
}
