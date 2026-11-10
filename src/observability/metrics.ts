import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

export interface Metrics {
  registry: Registry;
  transactionsTotal: Counter<'status'>;
  idempotentReplaysTotal: Counter<string>;
  processingSeconds: Histogram<string>;
  lockConflictsTotal: Counter<string>;
  retriesTotal: Counter<'queue'>;
  dlqMessagesTotal: Counter<string>;
  reconciliationDivergencesTotal: Counter<string>;
  outboxPublishFailuresTotal: Counter<string>;
  outboxLagSeconds: Gauge<string>;
}

let cached: Metrics | undefined;

export function getMetrics(): Metrics {
  if (cached) return cached;
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  cached = {
    registry,
    transactionsTotal: new Counter({
      name: 'wager_transactions_total',
      help: 'Wager transactions grouped by terminal status',
      labelNames: ['status'],
      registers: [registry],
    }),
    idempotentReplaysTotal: new Counter({
      name: 'wager_idempotent_replays_total',
      help: 'Submissions answered from an existing idempotent transaction',
      registers: [registry],
    }),
    processingSeconds: new Histogram({
      name: 'wager_processing_seconds',
      help: 'End-to-end submit use case latency in seconds',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
    lockConflictsTotal: new Counter({
      name: 'wager_lock_conflicts_total',
      help: 'Deadlocks or serialization failures observed while processing',
      registers: [registry],
    }),
    retriesTotal: new Counter({
      name: 'wager_retries_total',
      help: 'Message redeliveries or retry attempts',
      labelNames: ['queue'],
      registers: [registry],
    }),
    dlqMessagesTotal: new Counter({
      name: 'wager_dlq_messages_total',
      help: 'Messages forwarded to the dead letter queue',
      registers: [registry],
    }),
    reconciliationDivergencesTotal: new Counter({
      name: 'reconciliation_divergences_total',
      help: 'Wallets whose stored balance differs from ledger reconstruction',
      registers: [registry],
    }),
    outboxPublishFailuresTotal: new Counter({
      name: 'outbox_publish_failures_total',
      help: 'Outbox publish attempts that failed and were scheduled for retry',
      registers: [registry],
    }),
    outboxLagSeconds: new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Age in seconds of the oldest unpublished outbox message',
      registers: [registry],
    }),
  };
  return cached;
}
