import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { WalletNotFoundError } from '../../domain/errors';
import type { Wallet } from '../../domain/wallet';
import { ApiException } from '../../common/api-exception';
import { createWalletSchema, idSchema, parseOrThrow } from '../wagering/dto';
import { WalletService } from './wallet.service';

function toResponse(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.amount,
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

@Controller('wallets')
export class WalletController {
  constructor(private readonly wallets: WalletService) {}

  @Post()
  async create(@Body() body: unknown) {
    const dto = parseOrThrow(createWalletSchema, body);
    const wallet = await this.wallets.create(dto);
    return toResponse(wallet);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) {
      throw new ApiException(400, {
        code: 'VALIDATION_ERROR',
        message: 'id must be a UUID',
        retryable: false,
      });
    }
    const wallet = await this.wallets.get(parsed.data);
    if (!wallet) throw new WalletNotFoundError(parsed.data);
    return toResponse(wallet);
  }
}
