import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/domain/money';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors';

describe('Money', () => {
  it('parses and normalizes to fixed scale 2', () => {
    expect(Money.from({ amount: '25', currency: 'BRL' }).amount).toBe('25.00');
    expect(Money.from({ amount: '25.5', currency: 'BRL' }).amount).toBe('25.50');
    expect(Money.from({ amount: ' 0.01 ', currency: 'BRL' }).amount).toBe('0.01');
    expect(Money.from({ amount: '0010.10', currency: 'brl' }).amount).toBe('10.10');
    expect(Money.from({ amount: '0', currency: 'BRL' }).toString()).toBe('0.00');
  });

  it.each([
    '',
    '   ',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e3',
    '1E3',
    '25.001',
    '25.000',
    '1.',
    '.5',
    'abc',
    '-5',
    '+5',
    '1,5',
    '1 000',
    '0x10',
  ])('rejects invalid amount %p', (amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  it.each(['', 'BR', 'BRLL', '12A', 'B R'])('rejects invalid currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  it('zero uses the requested currency', () => {
    const zero = Money.zero('USD');
    expect(zero.isZero()).toBe(true);
    expect(zero.currency).toBe('USD');
    expect(zero.toString()).toBe('0.00');
  });

  it('add/subtract return new instances (immutability)', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '2.50', currency: 'BRL' });
    const sum = a.add(b);
    const diff = a.subtract(b);
    expect(sum.amount).toBe('12.50');
    expect(diff.amount).toBe('7.50');
    expect(a.amount).toBe('10.00');
    expect(sum).not.toBe(a);
    expect(diff).not.toBe(a);
  });

  it('keeps cents correct without floating point issues', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 10; i++) {
      total = total.add(Money.from({ amount: '0.10', currency: 'BRL' }));
    }
    expect(total.amount).toBe('1.00');
    expect(total.add(Money.from({ amount: '0.20', currency: 'BRL' })).amount).toBe('1.20');
  });

  it('negate flips sign and preserves currency', () => {
    const value = Money.from({ amount: '25.00', currency: 'BRL' });
    const negated = value.negate();
    expect(negated.amount).toBe('-25.00');
    expect(negated.isNegative()).toBe(true);
    expect(negated.currency).toBe('BRL');
    expect(negated.negate().equals(value)).toBe(true);
  });

  it('comparisons and predicates work', () => {
    const small = Money.from({ amount: '1.00', currency: 'BRL' });
    const big = Money.from({ amount: '2.00', currency: 'BRL' });
    expect(small.isLessThan(big)).toBe(true);
    expect(big.isLessThan(small)).toBe(false);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(Money.zero('BRL').isNegative()).toBe(false);
    expect(small.isPositive()).toBe(true);
    expect(small.isNegative()).toBe(false);
    expect(small.equals(Money.from({ amount: '1', currency: 'BRL' }))).toBe(true);
    expect(small.equals(big)).toBe(false);
  });

  it('rejects arithmetic across currencies', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl.equals(usd)).toBe(false);
  });

  it('serializes with fixed scale 2', () => {
    const money = Money.from({ amount: '3.5', currency: 'BRL' });
    expect(money.toJSON()).toEqual({ amount: '3.50', currency: 'BRL' });
    expect(JSON.stringify({ money })).toBe('{"money":{"amount":"3.50","currency":"BRL"}}');
  });

  it('rehydrate accepts persisted scale and negative values', () => {
    expect(Money.rehydrate({ amount: '123.4', currency: 'BRL' }).amount).toBe('123.40');
    expect(Money.rehydrate({ amount: '-1.00', currency: 'BRL' }).amount).toBe('-1.00');
    expect(() => Money.rehydrate({ amount: 'NaN', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });
});
