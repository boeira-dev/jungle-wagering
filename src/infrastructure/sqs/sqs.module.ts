import { Global, Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { config } from '../../config';
import { SQS_CLIENT, SqsService } from './sqs.service';

@Global()
@Module({
  providers: [
    {
      provide: SQS_CLIENT,
      useFactory: () =>
        new SQSClient({
          region: config.sqs.region,
          endpoint: config.sqs.endpoint,
          credentials: {
            accessKeyId: config.sqs.accessKeyId,
            secretAccessKey: config.sqs.secretAccessKey,
          },
        }),
    },
    SqsService,
  ],
  exports: [SQS_CLIENT, SqsService],
})
export class SqsModule {}
