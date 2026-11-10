import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ApplicationModule } from './application/application.module';
import { AuthGuard } from './common/auth.guard';
import { AllExceptionsFilter } from './common/exception.filter';
import {
  NoopProviderIdentity,
  PROVIDER_IDENTITY_PORT,
} from './common/provider-identity';
import { HealthModule } from './health/health.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { SqsModule } from './infrastructure/sqs/sqs.module';
import { ObservabilityModule } from './observability/observability.module';

@Module({
  imports: [
    DatabaseModule,
    SqsModule,
    ObservabilityModule,
    ApplicationModule,
    HealthModule,
  ],
  providers: [
    { provide: PROVIDER_IDENTITY_PORT, useClass: NoopProviderIdentity },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
