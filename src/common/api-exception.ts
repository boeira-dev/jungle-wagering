import { HttpException } from '@nestjs/common';

export interface ApiErrorBody {
  code: string;
  message: string;
  failureCode?: string | null;
  retryable: boolean;
}

export class ApiException extends HttpException {
  constructor(
    status: number,
    readonly body: ApiErrorBody,
    readonly retryAfterSeconds?: number,
  ) {
    super(body, status);
  }
}
