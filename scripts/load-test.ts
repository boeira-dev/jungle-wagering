/**
 * Multi-instance load check.
 *
 * Usage:
 *   BASE_URLS=http://127.0.0.1:13000,http://127.0.0.1:13001 bun run scripts/load-test.ts
 *
 * Scenario A: 50 concurrent 10.00 bets against a 100.00 wallet spread over all
 * instances -> exactly 10 processed, 40 rejected for insufficient funds, final
 * balance 0.00 and no other status code.
 *
 * Scenario B: 10 concurrent submissions sharing one idempotency key -> one
 * business effect, nine idempotent replays, final balance 90.00.
 *
 * Scenario C: the same idempotency key with a different payload -> 409.
 */

const RAW_BASES = (process.env.BASE_URLS ?? 'http://127.0.0.1:13000')
  .split(',')
  .map((value) => value.trim().replace(/\/+$/, ''))
  .filter((value) => value.length > 0);

if (RAW_BASES.length === 0) {
  throw new Error('BASE_URLS must contain at least one base URL');
}

const BASES: string[] = RAW_BASES;
let failures = 0;

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

function fail(message: string): void {
  failures += 1;
  console.error(`FAIL ${message}`);
}

function baseFor(index: number): string {
  return BASES[index % BASES.length];
}

async function parse(response: Response): Promise<JsonResponse> {
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { raw: text };
    }
  }
  return { status: response.status, body };
}

async function post(
  path: string,
  payload: unknown,
  idempotencyKey: string,
  base: string,
): Promise<JsonResponse> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
  return parse(response);
}

async function get(path: string, base: string): Promise<JsonResponse> {
  const response = await fetch(`${base}${path}`);
  return parse(response);
}

async function createWallet(balance: string): Promise<{ id: string; playerId: string }> {
  const playerId = `load-player-${crypto.randomUUID()}`;
  const response = await post(
    '/wallets',
    { playerId, currency: 'BRL', initialBalance: balance },
    `wallet-${playerId}`,
    BASES[0],
  );
  if (response.status !== 201) {
    throw new Error(`wallet creation failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  const id = response.body.id;
  if (typeof id !== 'string' || typeof response.body.playerId !== 'string') {
    throw new Error('wallet response is missing id/playerId');
  }
  return { id, playerId: response.body.playerId };
}

function transactionBody(
  wallet: { id: string; playerId: string },
  providerId: string,
  externalTransactionId: string,
  amount: string,
) {
  return {
    providerId,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-load',
    gameId: 'game-load',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

async function scenarioConcurrentBets(): Promise<void> {
  const wallet = await createWallet('100.00');
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, index) => {
      const id = crypto.randomUUID();
      return post(
        '/wagering/transactions',
        transactionBody(wallet, 'provider-load-a', `load-a-${id}`, '10.00'),
        `load-a-${id}`,
        baseFor(index),
      );
    }),
  );

  const processed = results.filter((result) => result.status === 200);
  const rejected = results.filter(
    (result) => result.status === 422 && result.body.failureCode === 'INSUFFICIENT_FUNDS',
  );
  const unexpected = results.filter(
    (result) =>
      result.status !== 200 &&
      !(result.status === 422 && result.body.failureCode === 'INSUFFICIENT_FUNDS'),
  );

  if (processed.length !== 10) fail(`scenario A: expected 10 processed, got ${processed.length}`);
  if (rejected.length !== 40) fail(`scenario A: expected 40 rejected, got ${rejected.length}`);
  for (const result of unexpected) {
    fail(`scenario A: unexpected ${result.status} ${JSON.stringify(result.body)}`);
  }

  const after = await get(`/wallets/${wallet.id}`, BASES[0]);
  if (after.status !== 200) fail(`scenario A: wallet read returned ${after.status}`);
  if (after.body.balance !== '0.00') {
    fail(`scenario A: expected final balance 0.00, got ${String(after.body.balance)}`);
  }
  console.log(
    `scenario A: ${processed.length} processed, ${rejected.length} rejected, balance ${String(after.body.balance)}`,
  );
}

async function scenarioIdempotentReplay(): Promise<void> {
  const wallet = await createWallet('100.00');
  const idempotencyKey = `load-b-${crypto.randomUUID()}`;
  const externalTransactionId = `load-b-${crypto.randomUUID()}`;
  const payload = transactionBody(wallet, 'provider-load-b', externalTransactionId, '10.00');

  const results = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      post('/wagering/transactions', payload, idempotencyKey, baseFor(index)),
    ),
  );

  const processed = results.filter(
    (result) => result.status === 200 && result.body.idempotentReplay === false,
  );
  const replays = results.filter(
    (result) => result.status === 200 && result.body.idempotentReplay === true,
  );
  if (processed.length !== 1) fail(`scenario B: expected 1 first effect, got ${processed.length}`);
  if (replays.length !== 9) fail(`scenario B: expected 9 replays, got ${replays.length}`);
  for (const result of results) {
    if (result.status !== 200) {
      fail(`scenario B: unexpected ${result.status} ${JSON.stringify(result.body)}`);
    }
  }
  const transactionIds = new Set(results.map((result) => String(result.body.transactionId)));
  if (transactionIds.size !== 1) {
    fail(`scenario B: expected one transaction id, got ${transactionIds.size}`);
  }

  const after = await get(`/wallets/${wallet.id}`, BASES[0]);
  if (after.body.balance !== '90.00') {
    fail(`scenario B: expected final balance 90.00, got ${String(after.body.balance)}`);
  }

  const conflict = await post(
    '/wagering/transactions',
    transactionBody(wallet, 'provider-load-b', externalTransactionId, '11.00'),
    idempotencyKey,
    BASES[0],
  );
  if (conflict.status !== 409) {
    fail(`scenario C: expected 409 for a conflicting payload, got ${conflict.status}`);
  }
  console.log(
    `scenario B: 1 effect, ${replays.length} replays, balance ${String(after.body.balance)}; scenario C: ${conflict.status}`,
  );
}

async function main(): Promise<void> {
  console.log(`load test against ${BASES.join(', ')}`);
  await scenarioConcurrentBets();
  await scenarioIdempotentReplay();
  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log('load test OK');
}

void main();
