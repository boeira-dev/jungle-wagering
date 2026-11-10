import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../infrastructure/database/database.service';
import { SqsService } from '../infrastructure/sqs/sqs.service';

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(
    private readonly database: DatabaseService,
    private readonly sqs: SqsService,
  ) {}

  live() {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  }

  async ready() {
    const [database, sqs] = await Promise.allSettled([this.database.ping(), this.sqs.ping()]);
    const checks = {
      postgres: database.status === 'fulfilled' ? 'up' : 'down',
      sqs: sqs.status === 'fulfilled' ? 'up' : 'down',
    };
    if (checks.postgres !== 'up' || checks.sqs !== 'up') {
      throw new ServiceUnavailableException({
        status: 'error',
        checks,
        retryable: true,
      });
    }
    return { status: 'ok', checks };
  }
}
