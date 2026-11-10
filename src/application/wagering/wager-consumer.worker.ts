import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { ApiException } from '../../common/api-exception';
import { config } from '../../config';
import { SqsService } from '../../infrastructure/sqs/sqs.service';
import { MetricsService } from '../../observability/metrics.service';
import { parseOrThrow, sqsWagerMessageSchema, type SqsWagerMessage } from './dto';
import { SubmitWagerUseCase } from './submit-wager.use-case';

const CONSUMER_NAME = 'wager-transactions';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  if (error instanceof ApiException) {
    return `${error.body.code}: ${error.body.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Consumes `wager-transactions.fifo` and feeds each message through the same
 * use case as the HTTP endpoint.
 *
 * Delivery contract:
 * - success (processed, replay, pending reference or business rejection) -> delete;
 * - parse/validation failure, idempotency conflict or transient error -> leave the
 *   message for redelivery, so SQS' redrive policy eventually moves it to the DLQ.
 *
 * The inbox row is written in the same transaction as the business effect, so a
 * crash after commit but before the SQS delete is safely replayed on redelivery.
 */
@Injectable()
export class WagerConsumerWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WagerConsumerWorker.name);
  private readonly abort = new AbortController();
  private stopped = false;

  /** Overridable for integration tests; defaults to the configured wager queue. */
  queueName = config.sqs.wagerQueue;

  constructor(
    private readonly sqs: SqsService,
    private readonly submitWager: SubmitWagerUseCase,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!config.sqs.consumerEnabled) {
      this.logger.log('SQS wager consumer disabled');
      return;
    }
    this.logger.log(
      `SQS wager consumer polling ${this.queueName} (wait ${config.sqs.consumerWaitSeconds}s, max ${config.sqs.consumerMaxMessages})`,
    );
    void this.loop();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    this.abort.abort();
  }

  /** Receives and processes one batch. Exposed for integration tests. */
  async pollOnce(waitSeconds = config.sqs.consumerWaitSeconds): Promise<number> {
    const queueUrl = await this.sqs.getQueueUrl(this.queueName);
    const response = await this.sqs.raw.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: config.sqs.consumerMaxMessages,
        WaitTimeSeconds: waitSeconds,
        AttributeNames: ['All'],
      }),
      { abortSignal: this.abort.signal },
    );
    const messages = response.Messages ?? [];
    for (const message of messages) {
      await this.handleMessage(queueUrl, message);
    }
    return messages.length;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (this.stopped) return;
        this.logger.error(`SQS receive failed: ${describeError(error)}`);
        await sleep(config.sqs.consumerIdleBackoffMs);
      }
    }
  }

  private async handleMessage(queueUrl: string, message: Message): Promise<void> {
    const messageId = message.MessageId;
    if (!messageId) {
      this.logger.warn('Received an SQS message without MessageId; leaving it for redelivery');
      return;
    }

    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const groupId = message.Attributes?.MessageGroupId ?? messageId;

    try {
      const payload = this.parse(message.Body);
      const result = await this.submitWager.execute({
        providerId: payload.providerId,
        externalTransactionId: payload.externalTransactionId,
        idempotencyKey: payload.idempotencyKey ?? messageId,
        playerId: payload.playerId,
        walletId: payload.walletId,
        roundId: payload.roundId ?? null,
        gameId: payload.gameId ?? null,
        kind: payload.kind,
        money: payload.money,
        referenceExternalTransactionId: payload.referenceExternalTransactionId ?? null,
        source: 'sqs',
        correlationId: payload.correlationId ?? groupId,
        messageId,
        consumerName: CONSUMER_NAME,
      });
      await this.delete(queueUrl, message.ReceiptHandle);
      if (receiveCount > 1) this.metrics.recordRetry('wager');
      this.logger.debug(
        `Message ${messageId} -> ${result.status}${result.idempotentReplay ? ' (replay)' : ''}`,
      );
    } catch (error) {
      this.metrics.recordRetry('wager');
      if (receiveCount >= config.sqs.maxReceiveCount) this.metrics.recordDlq();
      this.logger.warn(
        `Message ${messageId} failed on receive ${receiveCount}/${config.sqs.maxReceiveCount}: ${describeError(error)}`,
      );
    }
  }

  private parse(body: string | undefined): SqsWagerMessage {
    if (!body) throw new Error('Empty message body');
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error('Message body is not valid JSON');
    }
    return parseOrThrow(sqsWagerMessageSchema, json);
  }

  private async delete(queueUrl: string, receiptHandle: string | undefined): Promise<void> {
    if (!receiptHandle) return;
    await this.sqs.raw.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
    );
  }
}
