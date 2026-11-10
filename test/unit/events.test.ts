import { describe, expect, it } from 'bun:test';
import {
  WagerTransactionProcessedEvent,
  WagerTransactionRejectedEvent,
  WalletBalanceChangedEvent,
} from '../../src/domain/events';
import { InboxMessage } from '../../src/domain/inbox-message';
import { OutboxMessage } from '../../src/domain/outbox-message';

const money = { amount: '10.00', currency: 'BRL' };

describe('IntegrationEvent', () => {
  it('serializes the envelope and keeps money as plain props', () => {
    const event = new WagerTransactionProcessedEvent({
      eventId: 'evt-1',
      aggregateId: 'tx-1',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      occurredAt: new Date('2026-01-01T00:00:00Z'),
      data: {
        transactionId: 'tx-1',
        providerId: 'provider-1',
        externalTransactionId: 'ext-1',
        walletId: 'wallet-1',
        playerId: 'player-1',
        kind: 'BET',
        status: 'PROCESSED',
        money,
        balanceAfter: { amount: '90.00', currency: 'BRL' },
      },
    });

    const envelope = event.toEnvelope();
    expect(envelope.eventType).toBe('WagerTransactionProcessed');
    expect(envelope.version).toBe(1);
    expect(envelope.eventId).toBe('evt-1');
    expect(envelope.occurredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(envelope.data.money).toEqual(money);
    expect(typeof envelope.data.money).toBe('object');
  });

  it('assigns a generated eventId when omitted', () => {
    const event = new WalletBalanceChangedEvent({
      aggregateId: 'wallet-1',
      correlationId: 'corr',
      data: {
        transactionId: 'tx-1',
        walletId: 'wallet-1',
        playerId: 'p1',
        currency: 'BRL',
        direction: 'DEBIT',
        previousBalance: '100.00',
        balance: '90.00',
        version: 2,
      },
    });
    expect(event.eventId.length).toBeGreaterThan(10);
    expect(event.causationId).toBeNull();
  });

  it('rejected event carries failure code', () => {
    const event = new WagerTransactionRejectedEvent({
      aggregateId: 'tx-1',
      correlationId: 'corr',
      data: {
        transactionId: 'tx-1',
        providerId: 'p',
        externalTransactionId: 'e',
        walletId: 'w',
        playerId: 'pl',
        kind: 'BET',
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        money,
      },
    });
    expect(event.toEnvelope().data.failureCode).toBe('INSUFFICIENT_FUNDS');
  });
});

describe('OutboxMessage', () => {
  it('is pending and due until published', () => {
    const message = OutboxMessage.create({
      aggregateId: 'a',
      eventType: 'E',
      payload: { x: 1 },
    });
    const now = new Date();
    expect(message.isPending()).toBe(true);
    expect(message.isDue(now)).toBe(true);
    message.markPublished(now);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(now)).toBe(false);
  });

  it('schedules exponential retry with cap and increments attempts', () => {
    const message = OutboxMessage.create({ aggregateId: 'a', eventType: 'E', payload: {} });
    const now = new Date('2026-01-01T00:00:00Z');
    message.scheduleRetry(now, { baseDelayMs: 1000, factor: 2, maxDelayMs: 4000 });
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt?.getTime()).toBe(now.getTime() + 1000);
    message.scheduleRetry(now, { baseDelayMs: 1000, factor: 2, maxDelayMs: 4000 });
    expect(message.attempts).toBe(2);
    expect(message.nextAttemptAt?.getTime()).toBe(now.getTime() + 2000);
    message.scheduleRetry(now, { baseDelayMs: 1000, factor: 2, maxDelayMs: 4000 });
    message.scheduleRetry(now, { baseDelayMs: 1000, factor: 2, maxDelayMs: 4000 });
    expect(message.nextAttemptAt?.getTime()).toBe(now.getTime() + 4000);
  });
});

describe('InboxMessage', () => {
  it('tracks processing state', () => {
    const message = InboxMessage.create({
      consumerName: 'c',
      messageId: 'm',
      payloadHash: 'h',
    });
    expect(message.isProcessed()).toBe(false);
    message.markProcessed(new Date());
    expect(message.isProcessed()).toBe(true);
  });
});
