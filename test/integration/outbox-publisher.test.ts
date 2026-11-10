import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { OutboxPublisherWorker } from '../../src/application/events/outbox-publisher.worker';
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

async function createWallet(initialBalance = '1.00') {
  return context.wallets.create({
    playerId: unique('player'),
    currency: 'BRL',
    initialBalance,
  });
}

/**
 * Other integration files leave unpublished outbox rows behind. Mark them as
 * published so a drain only sees events created by the current test.
 */
async function parkOutbox(): Promise<void> {
  await query(
    context,
    `UPDATE outbox_messages
     SET published_at = now(), next_attempt_at = NULL
     WHERE published_at IS NULL`,
  );
}

/** Marks every unpublished row except this causation chain as published. */
async function isolateOutbox(causationId: string): Promise<void> {
  await query(
    context,
    `UPDATE outbox_messages
     SET published_at = now(), next_attempt_at = NULL
     WHERE published_at IS NULL AND payload->>'causationId' <> ?`,
    [causationId],
  );
}

interface OutboxRow {
  id: string;
  event_type: string;
  attempts: number;
  published_at: Date | string | null;
  next_attempt_at: Date | string | null;
}

async function outboxFor(causationId: string): Promise<OutboxRow[]> {
  return query<OutboxRow>(
    context,
    `SELECT id, event_type, attempts, published_at, next_attempt_at
     FROM outbox_messages
     WHERE payload->>'causationId' = ?
     ORDER BY event_type`,
    [causationId],
  );
}

async function openingTransaction(walletId: string): Promise<string> {
  const [row] = await query<{ id: string }>(
    context,
    "SELECT id FROM wager_transactions WHERE wallet_id = ? AND kind = 'OPENING'",
    [walletId],
  );
  return row.id;
}

function failingQueue(): SqsService {
  return {
    getQueueUrl: async () => 'http://sqs.invalid/queue',
    raw: {
      send: async () => {
        throw new Error('sqs unavailable');
      },
    },
  } as unknown as SqsService;
}

function recordingQueue(sent: string[]): SqsService {
  return {
    getQueueUrl: async () => 'http://sqs.invalid/queue',
    raw: {
      send: async (command: { input?: { MessageDeduplicationId?: string } }) => {
        const id = command.input?.MessageDeduplicationId;
        if (id) sent.push(id);
        return {};
      },
    },
  } as unknown as SqsService;
}

interface Envelope {
  eventId: string;
  eventType: string;
  version: number;
  aggregateId: string;
  correlationId: string;
  causationId: string | null;
  occurredAt: string;
  data: unknown;
}

async function createTestQueue(): Promise<{ name: string; url: string }> {
  const name = `wager-events-test-${randomUUID()}.fifo`;
  await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  const result = await client.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!result.QueueUrl) throw new Error('QueueUrl unavailable');
  return { name, url: result.QueueUrl };
}

async function receiveUntil(
  queueUrl: string,
  wanted: Set<string>,
): Promise<Map<string, Envelope>> {
  const found = new Map<string, Envelope>();
  for (let attempt = 0; attempt < 20 && found.size < wanted.size; attempt++) {
    const result = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );
    for (const message of result.Messages ?? []) {
      if (!message.Body) continue;
      let envelope: Envelope;
      try {
        envelope = JSON.parse(message.Body) as Envelope;
      } catch {
        continue;
      }
      if (wanted.has(envelope.eventId)) found.set(envelope.eventId, envelope);
      if (message.ReceiptHandle) {
        await client.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
        );
      }
    }
  }
  return found;
}

describe('outbox publisher', () => {
  it(
    'publishes the outbox to SQS and marks rows published',
    async () => {
      const wallet = await createWallet('1.00');
      const opening = await openingTransaction(wallet.id);
      await isolateOutbox(opening);
      const before = await outboxFor(opening);
      expect(before).toHaveLength(2);
      const wanted = new Set(before.map((row) => row.id));

      const { url } = await createTestQueue();
      try {
        const queue = { getQueueUrl: async () => url, raw: client } as unknown as SqsService;
        const worker = new OutboxPublisherWorker(context.database, queue, context.metrics);
        expect(await worker.drain()).toBeGreaterThanOrEqual(2);

        const after = await outboxFor(opening);
        expect(after.every((row) => row.published_at !== null)).toBe(true);
        expect(after.every((row) => row.next_attempt_at === null)).toBe(true);
        expect(after.every((row) => row.attempts === 0)).toBe(true);

        const received = await receiveUntil(url, wanted);
        expect(received.size).toBe(2);
        expect([...received.values()].map((event) => event.eventType).sort()).toEqual([
          'WagerTransactionProcessed',
          'WalletBalanceChanged',
        ]);
        for (const event of received.values()) {
          expect(event.version).toBe(1);
          expect(wanted.has(event.eventId)).toBe(true);
          expect(event.occurredAt).toMatch(/T/);
          expect(event.causationId).toBe(opening);
        }
      } finally {
        await client.send(new DeleteQueueCommand({ QueueUrl: url }));
      }
    },
    30_000,
  );

  it('leaves failed publishes unpublished and backs off before retrying', async () => {
    const wallet = await createWallet('1.00');
    const opening = await openingTransaction(wallet.id);
    await isolateOutbox(opening);

    const worker = new OutboxPublisherWorker(
      context.database,
      failingQueue(),
      context.metrics,
    );
    expect(await worker.drain()).toBeGreaterThanOrEqual(2);

    let rows = await outboxFor(opening);
    expect(rows.every((row) => row.published_at === null)).toBe(true);
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
    for (const row of rows) {
      const delayMs = new Date(row.next_attempt_at as string).getTime() - Date.now();
      expect(delayMs).toBeGreaterThan(0);
      expect(delayMs).toBeLessThanOrEqual(2_000);
    }

    await query(
      context,
      `UPDATE outbox_messages
       SET next_attempt_at = now() + interval '1 hour'
       WHERE payload->>'causationId' = ?`,
      [opening],
    );
    await worker.drain();
    expect((await outboxFor(opening)).every((row) => row.attempts === 1)).toBe(true);

    await query(
      context,
      `UPDATE outbox_messages
       SET next_attempt_at = now() - interval '1 second'
       WHERE payload->>'causationId' = ?`,
      [opening],
    );

    const sent: string[] = [];
    const second = new OutboxPublisherWorker(
      context.database,
      recordingQueue(sent),
      context.metrics,
    );
    expect(await second.drain()).toBeGreaterThanOrEqual(2);

    rows = await outboxFor(opening);
    expect(rows.every((row) => row.published_at !== null)).toBe(true);
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
    for (const row of rows) {
      expect(sent.filter((id) => id === row.id)).toHaveLength(1);
    }
  });

  it(
    'claims each outbox row exactly once across concurrent publishers',
    async () => {
      await parkOutbox();
      const previousBatchSize = process.env.OUTBOX_BATCH_SIZE;
      process.env.OUTBOX_BATCH_SIZE = '5';
      try {
        for (let index = 0; index < 10; index++) {
          await createWallet('1.00');
        }

        const rows = await query<{ id: string }>(
          context,
          'SELECT id FROM outbox_messages WHERE published_at IS NULL',
        );
        expect(rows.length).toBeGreaterThanOrEqual(20);
        const ids = new Set(rows.map((row) => row.id));

        const sent: string[] = [];
        const queue = recordingQueue(sent);
        const workers = [0, 1].map(
          () => new OutboxPublisherWorker(context.database, queue, context.metrics),
        );
        await Promise.all(workers.map((worker) => worker.drain()));

        const stored = await query<{
          id: string;
          published_at: Date | string | null;
          attempts: number;
        }>(context, 'SELECT id, published_at, attempts FROM outbox_messages');
        const relevant = stored.filter((row) => ids.has(row.id));
        expect(relevant.every((row) => row.published_at !== null)).toBe(true);
        expect(relevant.every((row) => row.attempts === 0)).toBe(true);

        for (const id of ids) {
          expect(sent.filter((eventId) => eventId === id)).toHaveLength(1);
        }
      } finally {
        if (previousBatchSize === undefined) {
          delete process.env.OUTBOX_BATCH_SIZE;
        } else {
          process.env.OUTBOX_BATCH_SIZE = previousBatchSize;
        }
      }
    },
    30_000,
  );
});
