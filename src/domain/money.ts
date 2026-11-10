import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -1000,
  toExpPos: 1000,
});

const PLAIN_DECIMAL = /^\d+(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

function normalizeCurrency(currency: string): string {
  if (typeof currency !== 'string') {
    throw new InvalidMoneyError('Currency must be a string');
  }
  const normalized = currency.trim().toUpperCase();
  if (!CURRENCY.test(normalized)) {
    throw new InvalidMoneyError(`Invalid ISO-4217 currency: "${currency}"`);
  }
  return normalized;
}

function normalizeAmountInput(amount: string): string {
  if (typeof amount !== 'string') {
    throw new InvalidMoneyError('Amount must be a string decimal');
  }
  const normalized = amount.trim();
  if (normalized.length === 0) {
    throw new InvalidMoneyError('Amount must not be empty');
  }
  if (!PLAIN_DECIMAL.test(normalized)) {
    throw new InvalidMoneyError(
      `Invalid amount "${amount}": must be a plain non-negative decimal with at most 2 fraction digits`,
    );
  }
  return normalized;
}

/**
 * Immutable money value object. Internally backed by decimal.js; never uses
 * IEEE-754 floating point. Input contracts accept only non-negative plain
 * decimals (max 2 fraction digits). Serialization is always fixed scale 2.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    private readonly curr: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!props || typeof props !== 'object') {
      throw new InvalidMoneyError('Money props are required');
    }
    const currency = normalizeCurrency(props.currency);
    const amount = normalizeAmountInput(props.amount);
    const value = new Decimal(amount);
    if (!value.isFinite()) {
      throw new InvalidMoneyError(`Amount must be finite: "${props.amount}"`);
    }
    if (value.isNegative()) {
      throw new InvalidMoneyError(`Amount must not be negative: "${props.amount}"`);
    }
    return new Money(value, currency);
  }

  /** Rebuilds an already persisted value without input-contract restrictions. */
  static rehydrate(props: MoneyProps): Money {
    if (!props || typeof props.amount !== 'string' || typeof props.currency !== 'string') {
      throw new InvalidMoneyError('Invalid persisted money props');
    }
    const value = new Decimal(props.amount);
    if (!value.isFinite()) {
      throw new InvalidMoneyError('Persisted amount must be finite');
    }
    return new Money(value, normalizeCurrency(props.currency));
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0), normalizeCurrency(currency));
  }

  get amount(): string {
    return this.value.toFixed(2);
  }

  get currency(): string {
    return this.curr;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.curr);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.curr);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.curr);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.curr === other.curr && this.value.eq(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.curr };
  }

  toString(): string {
    return this.amount;
  }

  private assertSameCurrency(other: Money): void {
    if (this.curr !== other.curr) {
      throw new CurrencyMismatchError(this.curr, other.curr);
    }
  }
}
