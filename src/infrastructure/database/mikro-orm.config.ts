import type { Options } from '@mikro-orm/postgresql';
import { config } from '../../config';
import { ALL_SCHEMAS } from '../persistence/entities/schemas';

export function buildOrmConfig(entities: unknown[] = ALL_SCHEMAS): Options {
  return {
    clientUrl: config.databaseUrl,
    entities: entities as never[],
    discovery: { warnWhenNoEntities: false, checkDuplicateEntities: false },
    debug: config.nodeEnv === 'development' && process.env.ORM_DEBUG === 'true',
    allowGlobalContext: false,
    forceUtcTimezone: true,
    pool: { min: 0, max: 20 },
  };
}
