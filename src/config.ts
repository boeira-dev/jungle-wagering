function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export const config = {
  get nodeEnv(): string {
    return strEnv('NODE_ENV', 'development');
  },
  get isTest(): boolean {
    return this.nodeEnv === 'test';
  },
  get port(): number {
    return intEnv('PORT', 13000);
  },
  get logLevel(): string {
    return strEnv('LOG_LEVEL', 'info');
  },

  get databaseUrl(): string {
    return strEnv('DATABASE_URL', 'postgresql://jungle:jungle_local@127.0.0.1:15432/jungle');
  },

  sqs: {
    get endpoint(): string {
      return strEnv('SQS_ENDPOINT', 'http://127.0.0.1:14566');
    },
    get region(): string {
      return strEnv('AWS_REGION', 'us-east-1');
    },
    get accessKeyId(): string {
      return strEnv('AWS_ACCESS_KEY_ID', 'test');
    },
    get secretAccessKey(): string {
      return strEnv('AWS_SECRET_ACCESS_KEY', 'test');
    },
    get wagerQueue(): string {
      return strEnv('SQS_QUEUE_WAGER', 'wager-transactions.fifo');
    },
    get dlq(): string {
      return strEnv('SQS_QUEUE_DLQ', 'wager-transactions-dlq.fifo');
    },
    get eventsQueue(): string {
      return strEnv('SQS_QUEUE_EVENTS', 'wager-events.fifo');
    },
    get consumerEnabled(): boolean {
      return boolEnv('CONSUMER_ENABLED', true);
    },
    get visibilityTimeoutSeconds(): number {
      return intEnv('SQS_VISIBILITY_TIMEOUT', 5);
    },
    get maxReceiveCount(): number {
      return intEnv('SQS_MAX_RECEIVE_COUNT', 5);
    },
    get consumerWaitSeconds(): number {
      return intEnv('SQS_CONSUMER_WAIT_SECONDS', 20);
    },
    get consumerMaxMessages(): number {
      return intEnv('SQS_CONSUMER_MAX_MESSAGES', 10);
    },
    get consumerIdleBackoffMs(): number {
      return intEnv('SQS_CONSUMER_IDLE_BACKOFF_MS', 1_000);
    },
  },

  outbox: {
    get enabled(): boolean {
      return boolEnv('OUTBOX_ENABLED', true);
    },
    get pollIntervalMs(): number {
      return intEnv('OUTBOX_POLL_INTERVAL_MS', 200);
    },
    get batchSize(): number {
      return intEnv('OUTBOX_BATCH_SIZE', 50);
    },
    get baseDelayMs(): number {
      return intEnv('OUTBOX_BASE_DELAY_MS', 1_000);
    },
    get maxBackoffMs(): number {
      return intEnv('OUTBOX_MAX_BACKOFF_MS', 60_000);
    },
  },

  reconciliation: {
    get enabled(): boolean {
      return boolEnv('RECONCILIATION_ENABLED', true);
    },
    get intervalMs(): number {
      return intEnv('RECONCILIATION_INTERVAL_MS', 60_000);
    },
    get batchSize(): number {
      return intEnv('RECONCILIATION_BATCH_SIZE', 500);
    },
  },

  referenceWorker: {
    get enabled(): boolean {
      return boolEnv('REFERENCE_WORKER_ENABLED', true);
    },
    get pollIntervalMs(): number {
      return intEnv('REFERENCE_POLL_INTERVAL_MS', 500);
    },
    get batchSize(): number {
      return intEnv('REFERENCE_BATCH_SIZE', 100);
    },
    get baseDelayMs(): number {
      return intEnv('REFERENCE_BASE_DELAY_MS', 5_000);
    },
    get factor(): number {
      return intEnv('REFERENCE_BACKOFF_FACTOR', 2);
    },
    get maxAttempts(): number {
      return intEnv('REFERENCE_MAX_ATTEMPTS', 8);
    },
    get ttlMs(): number {
      return intEnv('REFERENCE_TTL_MS', 15 * 60 * 1000);
    },
  },
};
