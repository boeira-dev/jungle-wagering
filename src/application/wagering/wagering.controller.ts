import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Res,
} from '@nestjs/common';
import { ApiException } from '../../common/api-exception';
import {
  parseOrThrow,
  submitTransactionSchema,
} from './dto';
import {
  SubmitWagerUseCase,
  type SubmitWagerResult,
} from './submit-wager.use-case';

interface StatusResponse {
  status(code: number): void;
}

@Controller('wagering')
export class WageringController {
  constructor(private readonly submitWager: SubmitWagerUseCase) {}

  @Post('transactions')
  @HttpCode(200)
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new ApiException(400, {
        code: 'MISSING_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key header is required',
        retryable: false,
      });
    }

    const dto = parseOrThrow(submitTransactionSchema, body);
    const result = await this.submitWager.execute({
      ...dto,
      roundId: dto.roundId ?? null,
      gameId: dto.gameId ?? null,
      referenceExternalTransactionId: dto.referenceExternalTransactionId ?? null,
      idempotencyKey: idempotencyKey.trim(),
      correlationId: correlationId?.trim() || idempotencyKey.trim(),
      source: 'http',
    });

    return this.toResponse(result, response);
  }

  private toResponse(result: SubmitWagerResult, response: StatusResponse) {
    if (result.status === 'PROCESSED') {
      response.status(200);
      return this.body(result);
    }
    if (result.status === 'PENDING_REFERENCE') {
      response.status(202);
      return this.body(result);
    }
    throw new ApiException(422, {
      code: result.status === 'FAILED' ? 'TRANSACTION_FAILED' : 'TRANSACTION_REJECTED',
      message:
        result.status === 'FAILED'
          ? 'Transaction failed permanently'
          : 'Transaction was rejected',
      failureCode: result.failureCode,
      retryable: false,
    });
  }

  private body(result: SubmitWagerResult) {
    return {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance,
      idempotentReplay: result.idempotentReplay,
    };
  }
}
