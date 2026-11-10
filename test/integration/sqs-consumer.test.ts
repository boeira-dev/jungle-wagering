import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { WagerConsumerWorker } from '../../src/application/wagering/wager-consumer.worker';
import { config } from '../../src/config';
import type { SqsService } from '../../src/infrastructure/sqs/sqs.service';
import {
  createTestContext,
  query,
  unique,
  type TestContext,
} from '../support/context';

let context: TestContext;
let client: SQSClient;

beforeAll(async () => {
  context = await createTestContext();
  client = new SQSClient({
    region: config.sqs.region,
    endpoint: config.sqs.endpoint,
    credentials: {
      accessKeyId: config.sqs.accessKeyId,
      secretAccessKey: config.sqs.secretAccessKey,
    },
  });
});

afterAll(async () => {
  client.destroy();
  await context.close();
});

async function createWallet(initialBalance = '100.00') {
  return context.wallets.create({
    playerId: unique('player'),
    currency: 'BRL',
    initialBalance,
  });
}

async function createTestQueue(visibilityTimeout = 1): Promise<{ url: string }> {
  const name = `wager-consumer-test-${randomUUID()}.fifo`;
  await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: String(visibilityTimeout),
      },
    }),
  );
  const result = await client.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!result.QueueUrl) throw new Error('QueueUrl unavailable');
  return { url: result.QueueUrl };
}

function consumerFor(url: string): WagerConsumerWorker {
  const queue = {
    getQueueUrl: async () => url,
    raw: client,
  } as unknown as SqsService;
  return new WagerConsumerWorker(queue, context.submit, context.metrics);
}

interface SentMessage {
  messageId: string;
}

async function send(
  queueUrl: string,
  body: unknown,
  groupId: string = unique('group'),
): Promise<SentMessage> {
  const result = await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: randomUUID(),
    }),
  );
  if (!result.MessageId) throw new Error('MessageId unavailable');
  return { messageId: result.MessageId };
}

function wagerBody(
  wallet: { id: string; playerId: string },
  overrides: Record<string, unknown> = {},
) {
  return {
    providerId: 'provider-sqs',
    externalTransactionId: unique('ext'),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-sqs',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

async function assertQueueEmpty(queueUrl: string): Promise<void> {
  const result = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 0,
      VisibilityTimeout: 0,
    }),
  );
  expect(result.Messages ?? []).toHaveLength(0);
}

describe('sqs wager consumer', () => {
  it('processes a valid message, records the inbox and deletes it', async () => {
    const wallet = await createWallet('100.00');
    const { url } = await createTestQueue();
    try {
      const consumer = consumerFor(url);
      const body = wagerBody(wallet);
      const sent = await send(url, body);

      expect(await consumer.pollOnce(1)).toBe(1);

      const [transaction] = await query<{ status: string; balance_after: string }>(
        context,
        'SELECT status, balance_after FROM wager_transactions WHERE external_transaction_id = ?',
        [body.externalTransactionId],
      );
      expect(transaction.status).toBe('PROCESSED');
      expect(transaction.balance_after).toBe('75.00');

      const [stored] = await query<{ balance: string; version: number }>(
        context,
        'SELECT balance, version FROM wallets WHERE id = ?',
        [wallet.id],
      );
      expect(stored).toEqual({ balance: '75.00', version: 2 });

      const [inbox] = await query<{ processed_at: Date | string | null }>(
        context,
        'SELECT processed_at FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
        ['wager-transactions', sent.messageId],
      );
      expect(inbox.processed_at).not.toBeNull();

      await assertQueueEmpty(url);
    } finally {
      await client.send(new DeleteQueueCommand({ QueueUrl: url }));
    }
  }, 30_000);

  it('deduplicates the same business transaction delivered by two messages', async () => {
    const wallet = await createWallet('100.00');
    const { url } = await createTestQueue();
    try {
      const consumer = consumerFor(url);
      const body = wagerBody(wallet);
      const group = unique('group');
      const first = await send(url, body, group);
      const second = await send(url, body, group);

      expect(await consumer.pollOnce(1)).toBe(2);

      const transactions = await query<{ id: string; status: string }>(
        context,
        'SELECT id, status FROM wager_transactions WHERE external_transaction_id = ?',
        [body.externalTransactionId],
      );
      expect(transactions).toHaveLength(1);
      expect(transactions[0].status).toBe('PROCESSED');

      const [stored] = await query<{ balance: string; version: number }>(
        context,
        'SELECT balance, version FROM wallets WHERE id = ?',
        [wallet.id],
      );
      expect(stored).toEqual({ balance: '75.00', version: 2 });

      const ledger = await query<{ id: string }>(
        context,
        'SELECT id FROM wallet_ledger_entries WHERE transaction_id = ?',
        [transactions[0].id],
      );
      expect(ledger).toHaveLength(1);

      const inbox = await query<{ message_id: string; processed_at: Date | string | null }>(
        context,
        'SELECT message_id, processed_at FROM inbox_messages WHERE message_id IN (?, ?)',
        [first.messageId, second.messageId],
      );
      expect(inbox).toHaveLength(2);
      expect(inbox.every((row) => row.processed_at !== null)).toBe(true);

      await assertQueueEmpty(url);
    } finally {
      await client.send(new DeleteQueueCommand({ QueueUrl: url }));
    }
  }, 30_000);

  it('deletes business rejections instead of poisoning the queue', async () => {
    const wallet = await createWallet('10.00');
    const { url } = await createTestQueue();
    try {
      const consumer = consumerFor(url);
      const body = wagerBody(wallet);
      await send(url, body);

      expect(await consumer.pollOnce(1)).toBe(1);

      const [transaction] = await query<{ status: string; failure_code: string }>(
        context,
        'SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = ?',
        [body.externalTransactionId],
      );
      expect(transaction).toEqual({
        status: 'REJECTED',
        failure_code: 'INSUFFICIENT_FUNDS',
      });

      const [stored] = await query<{ balance: string }>(
        context,
        'SELECT balance FROM wallets WHERE id = ?',
        [wallet.id],
      );
      expect(stored.balance).toBe('10.00');

      await assertQueueEmpty(url);
    } finally {
      await client.send(new DeleteQueueCommand({ QueueUrl: url }));
    }
  }, 30_000);

  it('leaves an unparseable message for retry and DLQ', async () => {
    const { url } = await createTestQueue(1);
    try {
      const consumer = consumerFor(url);
      const sent = await send(url, { unexpected: true });

      expect(await consumer.pollOnce(1)).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const received = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: url,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 0,
          AttributeNames: ['All'],
        }),
      );
      const messages = received.Messages ?? [];
      expect(messages).toHaveLength(1);
      expect(messages[0].MessageId).toBe(sent.messageId);
      expect(
        Number(messages[0].Attributes?.ApproximateReceiveCount ?? '0'),
      ).toBeGreaterThanOrEqual(2);

      if (messages[0].ReceiptHandle) {
        await client.send(
          new DeleteMessageCommand({
            QueueUrl: url,
            ReceiptHandle: messages[0].ReceiptHandle,
          }),
        );
      }
    } finally {
      await client.send(new DeleteQueueCommand({ QueueUrl: url }));
    }
  }, 30_000);

  it('processes each message exactly once across concurrent consumers', async () => {
    const wallet = await createWallet('200.00');
    const { url } = await createTestQueue(5);
    try {
      const prefix = unique('ext-batch');
      for (let index = 0; index < 20; index++) {
        const body = wagerBody(wallet, {
          externalTransactionId: `${prefix}-${index}`,
          money: { amount: '5.00', currency: 'BRL' },
        });
        await send(url, body, `${prefix}-${index}`);
      }

      const workers = [consumerFor(url), consumerFor(url)];
      for (let round = 0; round < 3; round++) {
        await Promise.all(workers.map((worker) => worker.pollOnce(1)));
      }

      const processed = await query<{ external_transaction_id: string }>(
        context,
        `SELECT external_transaction_id
         FROM wager_transactions
         WHERE status = 'PROCESSED' AND external_transaction_id LIKE ?`,
        [`${prefix}%`],
      );
      expect(processed).toHaveLength(20);
      expect(new Set(processed.map((row) => row.external_transaction_id)).size).toBe(20);

      const [stored] = await query<{ balance: string; version: number }>(
        context,
        'SELECT balance, version FROM wallets WHERE id = ?',
        [wallet.id],
      );
      expect(stored).toEqual({ balance: '100.00', version: 21 });

      await assertQueueEmpty(url);
    } finally {
      await client.send(new DeleteQueueCommand({ QueueUrl: url }));
    }
  }, 60_000);
});
