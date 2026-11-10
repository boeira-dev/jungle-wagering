import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { config } from '../../config';
import { SubmitWagerUseCase } from './submit-wager.use-case';

@Injectable()
export class ReferenceResolutionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReferenceResolutionWorker.name);
  private timer?: NodeJS.Timeout;
  private inFlight = false;

  constructor(private readonly submitWager: SubmitWagerUseCase) {}

  onModuleInit(): void {
    if (!config.referenceWorker.enabled) {
      this.logger.log('Reference resolution worker disabled');
      return;
    }
    this.timer = setInterval(() => {
      void this.runSafely();
    }, config.referenceWorker.pollIntervalMs);
    this.logger.log(
      `Reference resolution worker polling every ${config.referenceWorker.pollIntervalMs}ms`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Drains due pending references until the queue is empty or the batch is exhausted. */
  async drain(): Promise<number> {
    if (this.inFlight) return 0;
    this.inFlight = true;
    let processed = 0;
    try {
      while (processed < config.referenceWorker.batchSize) {
        const claimed = await this.submitWager.processNextPendingReference();
        if (!claimed) break;
        processed += 1;
      }
    } finally {
      this.inFlight = false;
    }
    return processed;
  }

  private async runSafely(): Promise<void> {
    try {
      await this.drain();
    } catch (error) {
      this.logger.error(`Reference resolution failed: ${(error as Error).message}`);
    }
  }
}
