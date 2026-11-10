import { Injectable } from '@nestjs/common';
import type { TransactionStatus } from '../domain/enums';
import { getMetrics, type Metrics } from './metrics';

@Injectable()
export class MetricsService {
  private readonly metrics: Metrics = getMetrics();

  recordTransaction(status: TransactionStatus): void {
    this.metrics.transactionsTotal.inc({ status });
  }

  recordReplay(): void {
    this.metrics.idempotentReplaysTotal.inc();
  }

  observeProcessing(seconds: number): void {
    this.metrics.processingSeconds.observe(seconds);
  }

  recordLockConflict(): void {
    this.metrics.lockConflictsTotal.inc();
  }

  recordRetry(queue: string): void {
    this.metrics.retriesTotal.inc({ queue });
  }

  recordDlq(): void {
    this.metrics.dlqMessagesTotal.inc();
  }

  recordReconciliationDivergence(): void {
    this.metrics.reconciliationDivergencesTotal.inc();
  }

  recordOutboxFailure(): void {
    this.metrics.outboxPublishFailuresTotal.inc();
  }

  setOutboxLag(seconds: number): void {
    this.metrics.outboxLagSeconds.set(seconds);
  }

  render(): Promise<string> {
    return this.metrics.registry.metrics();
  }

  get contentType(): string {
    return this.metrics.registry.contentType;
  }
}
