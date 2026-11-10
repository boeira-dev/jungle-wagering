import { describe, expect, it } from 'bun:test';
import { Wallet } from '../../src/domain/wallet';
import { Money } from '../../src/domain/money';
import { CurrencyMismatchError, InsufficientFundsError } from '../../src/domain/errors';
import { WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function reconstruct(entries: WalletLedgerEntry[], opening: Money): Money {
  return entries.reduce(
    (acc, entry) =>
      entry.direction === 'CREDIT' ? acc.add(entry.money) : acc.subtract(entry.money),
    opening,
  );
}

describe('Wallet aggregate', () => {
  it('starts with balance 0 and version 1', () => {
    const wallet = Wallet.create({ playerId: 'p1', currency: 'BRL' });
    expect(wallet.balance.amount).toBe('0.00');
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
  });

  it('accepts an initial balance and keeps version 1', () => {
    const wallet = Wallet.create({ playerId: 'p1', currency: 'BRL', initialBalance: brl('100.00') });
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('rejects initial balance with a different currency', () => {
    expect(() =>
      Wallet.create({
        playerId: 'p1',
        currency: 'BRL',
        initialBalance: Money.from({ amount: '1.00', currency: 'USD' }),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it('debit reduces balance, increments version and emits a balanced ledger entry', () => {
    const wallet = Wallet.create({ playerId: 'p1', currency: 'BRL', initialBalance: brl('100.00') });
    const entry = wallet.debit(brl('80.00'), 'tx-1');
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe('DEBIT');
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('20.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects insufficient funds without mutating the aggregate', () => {
    const wallet = Wallet.create({ playerId: 'p1', currency: 'BRL', initialBalance: brl('100.00') });
    expect(() => wallet.debit(brl('100.01'), 'tx-1')).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('credit increases balance and version', () => {
    const wallet = Wallet.create({ playerId: 'p1', currency: 'BRL' });
    const entry = wallet.credit(brl('25.00'), 'tx-1');
    expect(wallet.balance.amount).toBe('25.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe('CREDIT');
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects operations in a different currency', () => {
    const wallet = Wallet.create({ playerId: 'p1', currency: 'BRL' });
    expect(() => wallet.debit(Money.from({ amount: '1.00', currency: 'USD' }), 'tx')).toThrow(
      CurrencyMismatchError,
    );
    expect(() => wallet.credit(Money.from({ amount: '1.00', currency: 'USD' }), 'tx')).toThrow(
      CurrencyMismatchError,
    );
  });

  it('does not increment version when balance does not change', () => {
    const wallet = Wallet.create({ playerId: 'p1', currency: 'BRL', initialBalance: brl('10.00') });
    wallet.debit(brl('0.00'), 'tx-1');
    expect(wallet.version).toBe(1);
    wallet.credit(brl('0.00'), 'tx-2');
    expect(wallet.version).toBe(1);
  });

  it('keeps balance equal to the ledger reconstruction across many operations', () => {
    const wallet = Wallet.create({ playerId: 'p1', currency: 'BRL', initialBalance: brl('100.00') });
    const entries: WalletLedgerEntry[] = [];
    entries.push(wallet.debit(brl('80.00'), 'tx-1'));
    entries.push(wallet.credit(brl('30.50'), 'tx-2'));
    entries.push(wallet.debit(brl('20.25'), 'tx-3'));
    entries.push(wallet.credit(brl('0.75'), 'tx-4'));
    expect(wallet.balance.amount).toBe('31.00');
    expect(reconstruct(entries, brl('100.00')).amount).toBe(wallet.balance.amount);
  });
});
