import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/domain/money';
import { WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  UnbalancedLedgerEntryError,
} from '../../src/domain/errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('WalletLedgerEntry', () => {
  it('creates a balanced DEBIT entry', () => {
    const entry = WalletLedgerEntry.create({
      walletId: 'w1',
      transactionId: 't1',
      direction: 'DEBIT',
      money: brl('10.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('90.00'),
    });
    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe('DEBIT');
  });

  it('creates a balanced CREDIT entry', () => {
    const entry = WalletLedgerEntry.create({
      walletId: 'w1',
      transactionId: 't1',
      direction: 'CREDIT',
      money: brl('10.00'),
      balanceBefore: brl('90.00'),
      balanceAfter: brl('100.00'),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects unbalanced entries', () => {
    expect(() =>
      WalletLedgerEntry.create({
        walletId: 'w1',
        transactionId: 't1',
        direction: 'CREDIT',
        money: brl('10.00'),
        balanceBefore: brl('90.00'),
        balanceAfter: brl('101.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('rejects negative amounts', () => {
    expect(() =>
      WalletLedgerEntry.create({
        walletId: 'w1',
        transactionId: 't1',
        direction: 'DEBIT',
        money: Money.rehydrate({ amount: '-10.00', currency: 'BRL' }),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('110.00'),
      }),
    ).toThrow(InvalidMoneyError);
  });

  it('rejects currency mismatch between amount and balances', () => {
    expect(() =>
      WalletLedgerEntry.create({
        walletId: 'w1',
        transactionId: 't1',
        direction: 'CREDIT',
        money: Money.from({ amount: '10.00', currency: 'USD' }),
        balanceBefore: brl('0.00'),
        balanceAfter: brl('10.00'),
      }),
    ).toThrow(CurrencyMismatchError);
  });
});
