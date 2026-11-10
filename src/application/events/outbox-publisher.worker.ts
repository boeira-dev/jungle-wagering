import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { config } from '../../config';
import { DatabaseService } from '../../infrastructure/database/database.service';
import { SqsService } from '../../infrastructure/sqs/sqs.service';
import { MetricsService } from '../../observability/metrics.service';

interface ClaimedOutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  occurred_at: Date | string;
  attempts: number;
}

interface LagRow {
  lag: string | null;
}

const LEASE_MS = 30_000;
const MAX_BATCHES_PER_DRAIN = 10;

const CLAIM_BATCH = `
  UPDATE outbox_messages
  SET next_attempt_at = ?
  WHERE id IN (
    SELECT id
    FROM outbox_messages
    WHERE published_at IS NULL
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY occurred_at, id
    LIMIT ?
    FOR UPDATE SKIP LOCKED
  )
  RETURNING id, aggregate_id, event_type, payload, occurred_at, attempts
`;

const MARK_PUBLISHED = `
  UPDATE outbox_messages
  SET published_at = ?, next_attempt_at = NULL
  WHERE id = ? AND published_at IS NULL
`;

const SCHEDULE_RETRY = `
  UPDATE outbox_messages
  SET attempts = attempts + 1, next_attempt_at = ?
  WHERE id = ? AND published_at IS NULL
`;

const OLDEST_UNPUBLISHED_LAG = `
  SELECT EXTRACT(EPOCH FROM (now() - min(occurred_at)))::text AS lag
  FROM outbox_messages
  WHERE published_at IS NULL
`;

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private timer?: NodeJS.Timeout;
  private inFlight = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly sqs: SqsService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!config.outbox.enabled) {
      this.logger.log('Outbox publisher disabled');
      return;
    }
    this.timer = setInterval(() => {
      void this.runSafely();
    }, config.outbox.pollIntervalMs);
    this.logger.log(`Outbox publisher polling every ${config.outbox.pollIntervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Publishes due outbox rows; returns how many rows were claimed. */
  async drain(): Promise<number> {
    if (this.inFlight) return 0;
    this.inFlight = true;
    let total = 0;
    try {
      for (let batch = 0; batch < MAX_BATCHES_PER_DRAIN; batch++) {
        const claimed = await this.publishBatch();
        total += claimed;
        if (claimed < config.outbox.batchSize) break;
      }
    } finally {
      this.inFlight = false;
      await this.updateLagSafely();
    }
    return total;
  }

  private async publishBatch(): Promise<number> {
    const claimedAt = new Date();
    const leaseUntil = new Date(claimedAt.getTime() + LEASE_MS);
    const em = this.database.fork();
    const rows = (await em.execute(CLAIM_BATCH, [
      leaseUntil,
      claimedAt,
      config.outbox.batchSize,
    ])) as ClaimedOutboxRow[];

    if (rows.length === 0) return 0;

    let queueUrl: string;
    try {
      queueUrl = await this.sqs.getQueueUrl(config.sqs.eventsQueue);
    } catch (error) {
      this.metrics.recordOutboxFailure();
      this.logger.error(`Could not resolve events queue: ${(error as Error).message}`);
      for (const row of rows) {
        await this.scheduleRetry(row.id, row.attempts + 1, new Date());
      }
      return rows.length;
    }

    for (const row of rows) {
      try {
        await this.sqs.raw.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody:
              typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload),
            MessageGroupId: row.aggregate_id,
            MessageDeduplicationId: row.id,
          }),
        );
        await em.execute(MARK_PUBLISHED, [new Date(), row.id]);
      } catch (error) {
        this.metrics.recordOutboxFailure();
        await this.scheduleRetry(row.id, row.attempts + 1, new Date());
        this.logger.warn(`Outbox event ${row.id} failed to publish: ${(error as Error).message}`);
      }
    }

    return rows.length;
  }

  private async scheduleRetry(id: string, attempts: number, now: Date): Promise<void> {
    const exponent = Math.max(attempts - 1, 0);
    const delayMs = Math.min(
      config.outbox.baseDelayMs * Math.pow(2, exponent),
      config.outbox.maxBackoffMs,
    );
    const nextAttemptAt = new Date(now.getTime() + delayMs);
    const em = this.database.fork();
    await em.execute(SCHEDULE_RETRY, [nextAttemptAt, id]);
  }

  private async updateLagSafely(): Promise<void> {
    try {
      const em = this.database.fork();
      const [row] = (await em.execute(OLDEST_UNPUBLISHED_LAG)) as LagRow[];
      const lag = row?.lag === null || row?.lag === undefined ? 0 : Number(row.lag);
      this.metrics.setOutboxLag(Number.isFinite(lag) ? lag : 0);
    } catch (error) {
      this.logger.debug(`Could not refresh outbox lag: ${(error as Error).message}`);
    }
  }

  private async runSafely(): Promise<void> {
    try {
      await this.drain();
    } catch (error) {
      this.logger.error(`Outbox publishing failed: ${(error as Error).message}`);
    }
  }
}
