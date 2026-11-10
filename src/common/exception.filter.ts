import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { DomainError } from '../domain/errors';
import { MetricsService } from '../observability/metrics.service';
import { ApiException, type ApiErrorBody } from './api-exception';
import type { HttpRequestLike, HttpResponseLike } from './http-types';

interface MappedError {
  status: number;
  body: ApiErrorBody;
  retryAfterSeconds?: number;
}

const TRANSIENT_PG_CODES = new Set([
  '40001',
  '40P01',
  '53300',
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
]);

const TRANSIENT_NET_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
]);

const LOCK_CONFLICT_CODES = new Set(['40001', '40P01']);

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const value = (error as { code?: unknown }).code;
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function isApiBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string' &&
    typeof (value as { retryable?: unknown }).retryable === 'boolean'
  );
}

function messageFrom(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'message' in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.join('; ');
  }
  return 'Request failed';
}

const DOMAIN_STATUS: Record<string, number> = {
  IDEMPOTENCY_CONFLICT: 409,
  WALLET_ALREADY_EXISTS: 409,
  WALLET_NOT_FOUND: 404,
};

@Injectable()
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly metrics: MetricsService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<HttpResponseLike>();
    const request = context.getRequest<HttpRequestLike>();
    const mapped = this.map(exception);

    if (mapped.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(mapped.retryAfterSeconds));
    }
    if (mapped.status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${mapped.status} ${mapped.body.code}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }
    response.status(mapped.status).json(mapped.body);
  }

  private map(exception: unknown): MappedError {
    if (exception instanceof ApiException) {
      return {
        status: exception.getStatus(),
        body: exception.body,
        retryAfterSeconds: exception.retryAfterSeconds,
      };
    }

    if (exception instanceof DomainError) {
      return {
        status: DOMAIN_STATUS[exception.code] ?? 400,
        body: {
          code: exception.code,
          message: exception.message,
          retryable: false,
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      if (isApiBody(payload)) {
        return { status, body: payload };
      }
      return {
        status,
        body: {
          code: status === 404 ? 'NOT_FOUND' : 'REQUEST_ERROR',
          message: messageFrom(payload),
          retryable: false,
        },
      };
    }

    const code = errorCode(exception);
    if (code && LOCK_CONFLICT_CODES.has(code)) {
      this.metrics.recordLockConflict();
    }
    if (code && (TRANSIENT_PG_CODES.has(code) || TRANSIENT_NET_CODES.has(code))) {
      return {
        status: 503,
        body: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Temporarily unavailable, retry later',
          retryable: true,
        },
        retryAfterSeconds: 1,
      };
    }

    return {
      status: 500,
      body: {
        code: 'INTERNAL_ERROR',
        message: 'Unexpected error',
        retryable: false,
      },
    };
  }
}
