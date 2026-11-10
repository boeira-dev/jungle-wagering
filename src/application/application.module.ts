import { Module } from '@nestjs/common';
import { OutboxPublisherWorker } from './events/outbox-publisher.worker';
import { ReconciliationWorker } from './reconciliation/reconciliation.worker';
import { WageringModule } from './wagering/wagering.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [WalletModule, WageringModule],
  providers: [OutboxPublisherWorker, ReconciliationWorker],
})
export class ApplicationModule {}
