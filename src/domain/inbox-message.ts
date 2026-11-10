export interface InboxMessageProps {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export interface CreateInboxMessageParams {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt?: Date;
}

export class InboxMessage {
  private constructor(private readonly props: InboxMessageProps) {}

  static create(params: CreateInboxMessageParams): InboxMessage {
    return new InboxMessage({
      consumerName: params.consumerName,
      messageId: params.messageId,
      payloadHash: params.payloadHash,
      receivedAt: params.receivedAt ?? new Date(),
      processedAt: null,
    });
  }

  static rehydrate(props: InboxMessageProps): InboxMessage {
    return new InboxMessage({ ...props });
  }

  isProcessed(): boolean {
    return this.props.processedAt !== null;
  }

  markProcessed(now: Date = new Date()): void {
    if (this.props.processedAt) return;
    this.props.processedAt = now;
  }

  get consumerName(): string {
    return this.props.consumerName;
  }
  get messageId(): string {
    return this.props.messageId;
  }
  get payloadHash(): string {
    return this.props.payloadHash;
  }
  get receivedAt(): Date {
    return this.props.receivedAt;
  }
  get processedAt(): Date | null {
    return this.props.processedAt;
  }

  toProps(): InboxMessageProps {
    return { ...this.props };
  }
}
