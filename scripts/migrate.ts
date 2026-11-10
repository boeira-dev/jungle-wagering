import { config } from '../src/config';
import { migrate, type MigrationDirection } from '../src/infrastructure/database/migrations/runner';

const direction = (process.argv[2] ?? 'up') as MigrationDirection;
if (!['up', 'down', 'down-all'].includes(direction)) {
  console.error(`Unknown migration direction: ${direction}`);
  process.exit(1);
}

const result = await migrate(config.databaseUrl, direction);
console.log(JSON.stringify({ database: config.databaseUrl, direction, ...result }, null, 2));
