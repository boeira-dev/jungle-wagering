import { randomUUID } from 'node:crypto';
import { CurrencyMismatchError, InvalidMoneyError, UnbalancedLedgerEntryError } from './errors';
import type { LedgerDirection } from './enums';
import { Money } from './money';

export interface WalletLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface CreateLedgerEntryParams {
  id?: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

/** Immutable ledger entry. There are no setters nor state transitions. */
export class WalletLedgerEntry {
  private constructor(private readonly props: WalletLedgerEntryProps) {}

  static create(params: CreateLedgerEntryParams): WalletLedgerEntry {
    const entry = new WalletLedgerEntry({
      id: params.id ?? randomUUID(),
      walletId: params.walletId,
      transactionId: params.transactionId,
      direction: params.direction,
      money: params.money,
      balanceBefore: params.balanceBefore,
      balanceAfter: params.balanceAfter,
      createdAt: params.createdAt ?? new Date(),
    });

    if (params.money.isNegative()) {
      throw new InvalidMoneyError('Ledger amount must not be negative');
    }
    if (params.direction !== 'DEBIT' && params.direction !== 'CREDIT') {
      throw new InvalidMoneyError(`Invalid ledger direction: ${params.direction}`);
    }
    if (
      params.money.currency !== params.balanceBefore.currency ||
      params.money.currency !== params.balanceAfter.currency
    ) {
      throw new CurrencyMismatchError(
        params.money.currency,
        `${params.balanceBefore.currency}/${params.balanceAfter.currency}`,
      );
    }
    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError();
    }
    return entry;
  }

  static rehydrate(props: WalletLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(props);
  }

  isBalanced(): boolean {
    const expected =
      this.props.direction === 'DEBIT'
        ? this.props.balanceBefore.subtract(this.props.money)
        : this.props.balanceBefore.add(this.props.money);
    return expected.equals(this.props.balanceAfter);
  }

  get id(): string {
    return this.props.id;
  }

  get walletId(): string {
    return this.props.walletId;
  }

  get transactionId(): string {
    return this.props.transactionId;
  }

  get direction(): LedgerDirection {
    return this.props.direction;
  }

  get money(): Money {
    return this.props.money;
  }

  get balanceBefore(): Money {
    return this.props.balanceBefore;
  }

  get balanceAfter(): Money {
    return this.props.balanceAfter;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  toProps(): WalletLedgerEntryProps {
    return { ...this.props };
  }
}
