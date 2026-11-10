import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';
import { config } from '../../config';
import { DatabaseService } from '../../infrastructure/database/database.service';
import { MetricsService } from '../../observability/metrics.service';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

const SELECT_WALLET_BATCH = `
  SELECT w.id, w.currency, w.balance,
         COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::text
           AS ledger_balance
  FROM wallets w
  LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
  WHERE w.id > ?
  GROUP BY w.id, w.currency, w.balance
  ORDER BY w.id
  LIMIT ?
`;

interface WalletBalanceRow {
  id: string;
  currency: string;
  balance: string;
  ledger_balance: string;
}

export interface ReconciliationResult {
  checked: number;
  divergences: string[];
}

/**
 * Independently reconstructs each wallet balance from its immutable ledger and
 * compares it with the materialized balance. Read-only: it never repairs rows,
 * it only reports and increments `reconciliation_divergences_total`.
 *
 * The scan is keyset-paginated by wallet id, so it never loads the whole table
 * and remains safe to run on a live database.
 */
@Injectable()
export class ReconciliationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationWorker.name);
  private timer?: NodeJS.Timeout;
  private inFlight = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!config.reconciliation.enabled) {
      this.logger.log('Reconciliation worker disabled');
      return;
    }
    this.timer = setInterval(() => {
      void this.runSafely();
    }, config.reconciliation.intervalMs);
    this.logger.log(
      `Reconciliation worker every ${config.reconciliation.intervalMs}ms (batch ${config.reconciliation.batchSize})`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<ReconciliationResult> {
    if (this.inFlight) return { checked: 0, divergences: [] };
    this.inFlight = true;
    const divergences: string[] = [];
    let checked = 0;
    const em = this.database.fork();
    let cursor = ZERO_UUID;

    try {
      for (;;) {
        const rows = (await em.execute(SELECT_WALLET_BATCH, [
          cursor,
          config.reconciliation.batchSize,
        ])) as WalletBalanceRow[];
        if (rows.length === 0) break;

        for (const row of rows) {
          checked += 1;
          const stored = new Decimal(row.balance);
          const ledger = new Decimal(row.ledger_balance);
          if (!stored.equals(ledger)) {
            divergences.push(row.id);
            this.metrics.recordReconciliationDivergence();
            this.logger.error(
              `Wallet ${row.id} balance ${row.balance} differs from ledger ${row.ledger_balance} (${row.currency})`,
            );
          }
        }

        cursor = rows[rows.length - 1].id;
        if (rows.length < config.reconciliation.batchSize) break;
      }

      this.logger.log(
        `Reconciliation checked ${checked} wallets with ${divergences.length} divergences`,
      );
      return { checked, divergences };
    } finally {
      this.inFlight = false;
    }
  }

  private async runSafely(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(`Reconciliation failed: ${(error as Error).message}`);
    }
  }
}
