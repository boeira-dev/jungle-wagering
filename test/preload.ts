const fallback = 'postgresql://jungle:jungle_local@127.0.0.1:15432/jungle_test';
const current = process.env.DATABASE_URL;
if (!current || !current.includes('_test')) {
  process.env.DATABASE_URL = fallback;
}
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
