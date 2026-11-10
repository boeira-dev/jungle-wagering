import { Injectable } from '@nestjs/common';
import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { WagerTransaction } from '../../domain/wager-transaction';
import { WalletAlreadyExistsError } from '../../domain/errors';
import type { IntegrationEvent } from '../../domain/events';
import { computePayloadHash } from '../../domain/payload-hash';
import { DatabaseService } from '../../infrastructure/database/database.service';
import { WalletEntity } from '../../infrastructure/persistence/entities/models';
import {
  ledgerToEntity,
  txToEntity,
  walletFromEntity,
} from '../../infrastructure/persistence/mappers';
import {
  persistEvents,
  transactionProcessedEvent,
  walletBalanceChangedEvent,
} from '../events/event-outbox';

export interface CreateWalletInput {
  playerId: string;
  currency: string;
  initialBalance?: string;
}

@Injectable()
export class WalletService {
  constructor(private readonly database: DatabaseService) {}

  async create(input: CreateWalletInput): Promise<Wallet> {
    const currency = input.currency.trim().toUpperCase();
    const initial =
      input.initialBalance !== undefined
        ? Money.from({ amount: input.initialBalance, currency })
        : Money.zero(currency);
    const wallet = Wallet.create({
      playerId: input.playerId,
      currency,
      initialBalance: initial,
    });
    const now = wallet.createdAt;
    const em = this.database.fork();

    await em.transactional(async (trx) => {
      const rows = (await trx.execute(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (player_id, currency) DO NOTHING
         RETURNING id`,
        [
          wallet.id,
          wallet.playerId,
          wallet.currency,
          wallet.balance.amount,
          wallet.version,
          wallet.createdAt,
          wallet.updatedAt,
        ],
      )) as { id: string }[];

      if (rows.length === 0) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }

      if (initial.isPositive()) {
        const externalId = `opening:${wallet.id}`;
        const opening = WagerTransaction.create({
          providerId: 'internal',
          externalTransactionId: externalId,
          idempotencyKey: externalId,
          payloadHash: computePayloadHash({
            providerId: 'internal',
            externalTransactionId: externalId,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: null,
            gameId: null,
            kind: 'OPENING',
            money: initial.toJSON(),
            referenceExternalTransactionId: null,
          }),
          walletId: wallet.id,
          playerId: wallet.playerId,
          kind: 'OPENING',
          money: initial,
          now,
        });
        opening.markProcessed(initial, now);
        const ledger = WalletLedgerEntry.create({
          walletId: wallet.id,
          transactionId: opening.id,
          direction: 'CREDIT',
          money: initial,
          balanceBefore: Money.zero(currency),
          balanceAfter: initial,
          createdAt: now,
        });
        const events: IntegrationEvent<unknown>[] = [
          transactionProcessedEvent(opening, initial, wallet.id, now),
          walletBalanceChangedEvent(
            opening,
            wallet,
            ledger,
            Money.zero(currency),
            wallet.id,
            now,
          ),
        ];
        trx.persist(txToEntity(opening));
        await trx.flush();
        trx.persist(ledgerToEntity(ledger));
        persistEvents(trx, events);
      }

      await trx.flush();
    });

    return wallet;
  }

  async get(walletId: string): Promise<Wallet | null> {
    const em = this.database.fork();
    const entity = await em.findOne(WalletEntity, { id: walletId });
    return entity ? walletFromEntity(entity) : null;
  }
}
