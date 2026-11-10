import { randomUUID } from 'node:crypto';

export interface OutboxMessageProps {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
}

export interface CreateOutboxMessageParams {
  id?: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt?: Date;
}

export interface RetryPolicy {
  baseDelayMs?: number;
  factor?: number;
  maxDelayMs?: number;
}

export class OutboxMessage {
  private constructor(private readonly props: OutboxMessageProps) {}

  static create(params: CreateOutboxMessageParams): OutboxMessage {
    return new OutboxMessage({
      id: params.id ?? randomUUID(),
      aggregateId: params.aggregateId,
      eventType: params.eventType,
      payload: params.payload,
      occurredAt: params.occurredAt ?? new Date(),
      attempts: 0,
      nextAttemptAt: null,
      publishedAt: null,
    });
  }

  static rehydrate(props: OutboxMessageProps): OutboxMessage {
    return new OutboxMessage({ ...props });
  }

  isPending(): boolean {
    return this.props.publishedAt === null;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this.props.nextAttemptAt === null || this.props.nextAttemptAt <= now);
  }

  markPublished(now: Date = new Date()): void {
    this.props.publishedAt = now;
  }

  scheduleRetry(now: Date = new Date(), policy: RetryPolicy = {}): void {
    const base = policy.baseDelayMs ?? 1_000;
    const factor = policy.factor ?? 2;
    const max = policy.maxDelayMs ?? 60_000;
    this.props.attempts += 1;
    const delay = Math.min(base * Math.pow(factor, this.props.attempts - 1), max);
    this.props.nextAttemptAt = new Date(now.getTime() + delay);
  }

  get id(): string {
    return this.props.id;
  }
  get aggregateId(): string {
    return this.props.aggregateId;
  }
  get eventType(): string {
    return this.props.eventType;
  }
  get payload(): Record<string, unknown> {
    return this.props.payload;
  }
  get occurredAt(): Date {
    return this.props.occurredAt;
  }
  get attempts(): number {
    return this.props.attempts;
  }
  get nextAttemptAt(): Date | null {
    return this.props.nextAttemptAt;
  }
  get publishedAt(): Date | null {
    return this.props.publishedAt;
  }

  toProps(): OutboxMessageProps {
    return { ...this.props };
  }
}
