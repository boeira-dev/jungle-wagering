import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { config } from '../../config';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

@Injectable()
export class SqsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsService.name);
  private readonly urlCache = new Map<string, string>();

  constructor(@Inject(SQS_CLIENT) private readonly client: SQSClient) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureQueuesWithRetry(10, 1500);
    } catch (error) {
      this.logger.warn(
        `Could not bootstrap SQS queues on startup (will retry lazily): ${(error as Error).message}`,
      );
    }
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  async ensureQueuesWithRetry(attempts: number, delayMs: number): Promise<void> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        await this.ensureQueues();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  async ensureQueues(): Promise<void> {
    await this.createQueueIfMissing(config.sqs.dlq, {
      FifoQueue: 'true',
      ContentBasedDeduplication: 'false',
    });

    const dlqArn = await this.queueArn(config.sqs.dlq);
    const redrivePolicy = JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: String(config.sqs.maxReceiveCount),
    });

    await this.createQueueIfMissing(config.sqs.wagerQueue, {
      FifoQueue: 'true',
      ContentBasedDeduplication: 'false',
      VisibilityTimeout: String(config.sqs.visibilityTimeoutSeconds),
      RedrivePolicy: redrivePolicy,
    });

    await this.createQueueIfMissing(config.sqs.eventsQueue, {
      FifoQueue: 'true',
      ContentBasedDeduplication: 'false',
    });

    this.urlCache.clear();
  }

  private async createQueueIfMissing(name: string, attributes: Record<string, string>): Promise<void> {
    try {
      await this.client.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
    } catch (error) {
      const errName = (error as Error).name ?? '';
      if (!errName.includes('QueueNameExists') && !errName.includes('QueueAlreadyExists')) {
        throw error;
      }
      this.logger.debug(`Queue ${name} already exists`);
    }
  }

  private async queueArn(name: string): Promise<string> {
    const url = await this.getQueueUrl(name);
    const result = await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }),
    );
    const arn = result.Attributes?.QueueArn;
    if (!arn) throw new Error(`QueueArn unavailable for ${name}`);
    return arn;
  }

  async getQueueUrl(name: string): Promise<string> {
    const cached = this.urlCache.get(name);
    if (cached) return cached;
    const result = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!result.QueueUrl) throw new Error(`QueueUrl unavailable for ${name}`);
    this.urlCache.set(name, result.QueueUrl);
    return result.QueueUrl;
  }

  async ping(): Promise<void> {
    try {
      await this.getQueueUrl(config.sqs.wagerQueue);
    } catch {
      await this.ensureQueues();
    }
  }

  get raw(): SQSClient {
    return this.client;
  }
}
