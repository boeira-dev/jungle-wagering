import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from './mikro-orm.config';

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  private ormInstance?: MikroORM;

  async onModuleInit(): Promise<void> {
    if (this.ormInstance) return;
    this.ormInstance = await MikroORM.init(buildOrmConfig());
    this.logger.log('MikroORM connected');
  }

  get orm(): MikroORM {
    if (!this.ormInstance) throw new Error('MikroORM is not initialized');
    return this.ormInstance;
  }

  fork() {
    return this.orm.em.fork();
  }

  async ping(): Promise<void> {
    await this.orm.em.fork().execute('select 1');
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.ormInstance) {
      await this.ormInstance.close(true);
      this.ormInstance = undefined;
    }
  }
}
