import { Module } from '@nestjs/common';
import { ReferenceResolutionWorker } from './reference-resolution.worker';
import { SubmitWagerUseCase } from './submit-wager.use-case';
import { WagerConsumerWorker } from './wager-consumer.worker';
import { WageringController } from './wagering.controller';

@Module({
  controllers: [WageringController],
  providers: [SubmitWagerUseCase, ReferenceResolutionWorker, WagerConsumerWorker],
  exports: [SubmitWagerUseCase, ReferenceResolutionWorker, WagerConsumerWorker],
})
export class WageringModule {}
