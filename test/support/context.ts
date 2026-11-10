import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../src/infrastructure/database/database.service';
import { MetricsService } from '../../src/observability/metrics.service';
import { WalletService } from '../../src/application/wallet/wallet.service';
import {
  SubmitWagerUseCase,
  type SubmitWagerCommand,
} from '../../src/application/wagering/submit-wager.use-case';
import { ReferenceResolutionWorker } from '../../src/application/wagering/reference-resolution.worker';
import type { ExternalTransactionKind } from '../../src/domain/enums';

export interface TestContext {
  database: DatabaseService;
  metrics: MetricsService;
  wallets: WalletService;
  submit: SubmitWagerUseCase;
  referenceWorker: ReferenceResolutionWorker;
  close(): Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  const database = new DatabaseService();
  await database.onModuleInit();
  const submit = new SubmitWagerUseCase(database, new MetricsService());
  return {
    database,
    metrics: new MetricsService(),
    wallets: new WalletService(database),
    submit,
    referenceWorker: new ReferenceResolutionWorker(submit),
    close: () => database.onApplicationShutdown(),
  };
}

export function unique(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export interface CommandOverrides {
  walletId: string;
  playerId: string;
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  kind?: ExternalTransactionKind;
  amount?: string;
  currency?: string;
  roundId?: string | null;
  gameId?: string | null;
  referenceExternalTransactionId?: string | null;
  source?: 'http' | 'sqs';
  messageId?: string;
  consumerName?: string;
  correlationId?: string;
}

export function makeCommand(overrides: CommandOverrides): SubmitWagerCommand {
  return {
    providerId: overrides.providerId ?? 'provider-test',
    externalTransactionId: overrides.externalTransactionId ?? unique('ext'),
    idempotencyKey: overrides.idempotencyKey ?? unique('key'),
    playerId: overrides.playerId,
    walletId: overrides.walletId,
    roundId: overrides.roundId ?? 'round-1',
    gameId: overrides.gameId ?? 'game-1',
    kind: overrides.kind ?? 'BET',
    money: {
      amount: overrides.amount ?? '10.00',
      currency: overrides.currency ?? 'BRL',
    },
    referenceExternalTransactionId: overrides.referenceExternalTransactionId ?? null,
    source: overrides.source ?? 'http',
    correlationId: overrides.correlationId,
    messageId: overrides.messageId,
    consumerName: overrides.consumerName,
  };
}

export async function query<T = Record<string, unknown>>(
  context: TestContext,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const em = context.database.fork();
  return (await em.execute(sql, params)) as T[];
}
