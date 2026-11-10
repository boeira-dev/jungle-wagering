import { z } from 'zod';
import { ApiException } from '../../common/api-exception';
import { EXTERNAL_TRANSACTION_KINDS } from '../../domain/enums';

export const moneySchema = z
  .object({
    amount: z.string().min(1),
    currency: z.string().min(1),
  })
  .strict();

export const submitTransactionSchema = z
  .object({
    providerId: z.string().min(1).max(255),
    externalTransactionId: z.string().min(1).max(255),
    playerId: z.string().min(1).max(255),
    walletId: z.string().uuid(),
    roundId: z.string().min(1).max(255).nullish(),
    gameId: z.string().min(1).max(255).nullish(),
    kind: z.enum(EXTERNAL_TRANSACTION_KINDS),
    money: moneySchema,
    referenceExternalTransactionId: z.string().min(1).max(255).nullish(),
  })
  .strict();

export const sqsWagerMessageSchema = submitTransactionSchema.extend({
  idempotencyKey: z.string().min(1).max(255).optional(),
  correlationId: z.string().min(1).max(255).optional(),
});
export type SqsWagerMessage = z.infer<typeof sqsWagerMessageSchema>;

export const createWalletSchema = z
  .object({
    playerId: z.string().min(1).max(255),
    currency: z.string().length(3),
    initialBalance: z.string().optional(),
  })
  .strict();

export const idSchema = z.string().uuid();

export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => {
        const path = issue.path.join('.');
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join('; ');
    throw new ApiException(400, {
      code: 'VALIDATION_ERROR',
      message,
      retryable: false,
    });
  }
  return parsed.data;
}
