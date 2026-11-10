# Jungle Wagering

Distributed wagering processor for iGaming. It accepts wagers over HTTP and SQS,
serializes effects per wallet, enforces idempotency, writes an immutable ledger,
publishes integration events through a transactional outbox, resolves late
references, and continuously reconciles balances against the ledger.

## Architecture

```
HTTP  ──────────────┐
                    ├──> SubmitWagerUseCase ──> PostgreSQL
SQS wager queue ────┘        (one transaction:  wallets, wager_transactions,
                              wallet_ledger_entries, inbox_messages, outbox_messages)
                                          │
                                          └──> OutboxPublisherWorker ──> wager-events.fifo

ReferenceResolutionWorker  ──> retries / expires PENDING_REFERENCE transactions
WagerConsumerWorker        ──> SQS -> same submit use case, inbox dedup, DLQ redrive
ReconciliationWorker       ──> wallet.balance vs SUM(ledger CREDIT - DEBIT)
```

- **Money** is always a decimal string with scale 2, stored as `NUMERIC(19,2)`.
  No JavaScript floating point is used anywhere in the domain.
- **One row lock per wallet** (`SELECT ... FOR UPDATE`) serializes concurrent
  effects without global locks; the database remains the source of truth.
- **Idempotency** is a unique `idempotency_key` plus a canonical payload hash.
  Replays return the original transaction result; a different payload with the
  same key is a `409`.
- **Business identity** is unique on `(provider_id, external_transaction_id)`,
  so the same wager arriving through HTTP and SQS cannot be applied twice.
- **Integration events** are written to `outbox_messages` in the same database
  transaction as the business effect and published afterwards (at-least-once).
- **Inbox dedup** makes SQS redeliveries safe: the inbox row is committed with
  the effect, then the message is deleted.
- **Reference resolution** retries BET/WIN/REFUND references with exponential
  backoff (5s, 10s, 20s, ...), up to 8 attempts / 15 minutes, then rejects with
  `REFERENCE_NOT_FOUND_EXPIRED`.
- **Ledger immutability** is enforced by triggers: `UPDATE`, `DELETE` and
  `TRUNCATE` on `wallet_ledger_entries` fail.

## Stack

Bun 1.4, TypeScript (strict), NestJS 11, PostgreSQL 16, MikroORM 6, SQS
(LocalStack 3.8 locally), decimal.js, zod, prom-client.

## Quick start

Prerequisites: Docker + Compose, Bun 1.4+.

```bash
cp .env.example .env
docker compose -p jungle_wagering up -d
bun install
bun run migrate
bun run start
```

Health and metrics:

```bash
curl -s localhost:13000/health/live
curl -s localhost:13000/health/ready
curl -s localhost:13000/metrics | head
```

The app connects to Postgres on `127.0.0.1:15432`, SQS on
`127.0.0.1:14566`, and listens on `PORT` (default `13000`). On startup it
creates the three FIFO queues if they are missing.

### Multi-instance

```bash
PORT=13000 bun run start &
PORT=13001 bun run start &
PORT=13002 bun run start &
BASE_URLS=http://127.0.0.1:13000,http://127.0.0.1:13001,http://127.0.0.1:13002 \
  bun run scripts/load-test.ts
```

The load test checks that 50 concurrent 10.00 bets on a 100.00 wallet produce
exactly 10 processed / 40 rejected, that 10 concurrent submissions sharing one
idempotency key produce one effect and nine replays, and that a conflicting
payload returns `409`.

## API

### `POST /wallets`

```bash
curl -s -X POST localhost:13000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"player-1","currency":"BRL","initialBalance":"100.00"}'
```

`201` with `{id, playerId, currency, balance, version, createdAt, updatedAt}`.
A non-zero initial balance creates an `OPENING` transaction and a ledger entry
in the same commit. A zero balance creates neither.

### `GET /wallets/:id`

`200` with the wallet, `400` for a non-UUID, `404` when missing.

### `POST /wagering/transactions`

Requires `Idempotency-Key`; `X-Correlation-Id` is optional.

```bash
curl -s -X POST localhost:13000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'idempotency-key: bet-0001' \
  -d '{
    "providerId":"provider-1",
    "externalTransactionId":"ext-0001",
    "playerId":"player-1",
    "walletId":"<uuid>",
    "roundId":"round-1",
    "gameId":"game-1",
    "kind":"BET",
    "money":{"amount":"10.00","currency":"BRL"}
  }'
```

Kinds accepted from external sources: `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`.
`OPENING` is internal only. `REFUND` must reference a `BET`; `ROLLBACK` may
reference a `BET`, `WIN` or `REFUND`. Reversal amounts must equal the reference.

| Status | Meaning |
| --- | --- |
| `200` | processed, or idempotent replay (`idempotentReplay: true`) |
| `202` | reference not found yet; transaction is `PENDING_REFERENCE` |
| `400` | validation error or missing idempotency key |
| `404` | wallet not found |
| `409` | idempotency key or wallet conflict |
| `422` | business rejection; body carries `failureCode` |
| `503` | transient error (deadlock/serialization); retryable |

Errors use `{code, message, failureCode?, retryable}`.

### SQS input

`wager-transactions.fifo` carries the same fields as the HTTP body plus
optional `idempotencyKey` and `correlationId`:

```json
{
  "providerId": "provider-1",
  "externalTransactionId": "ext-0002",
  "playerId": "player-1",
  "walletId": "<uuid>",
  "roundId": "round-1",
  "kind": "BET",
  "money": { "amount": "10.00", "currency": "BRL" }
}
```

If `idempotencyKey` is omitted, the SQS `MessageId` is used. A producer retry
that creates a new `MessageId` is still safe: `(provider_id,
external_transaction_id)` plus the payload hash dedupes it.

Success (processed, replay, pending reference, or business rejection) deletes
the message. Parse errors, idempotency conflicts and transient failures leave
the message for redelivery; after 5 receives the redrive policy moves it to
`wager-transactions-dlq.fifo`.

### Operations

```bash
# health
curl -s localhost:13000/health/ready

# metrics (Prometheus)
curl -s localhost:13000/metrics

# inspect the DLQ
docker exec jw_localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --max-number-of-messages 10

# replay a DLQ message: send it to the main queue with a new dedup id, then delete it
```

Watch the `outbox_lag_seconds`, `outbox_publish_failures_total`,
`wager_retries_total{queue}`, `wager_dlq_messages_total`,
`wager_transactions_total{status}`, `wager_idempotent_replays_total` and
`reconciliation_divergences_total` metrics.

## Data model

| Table | Purpose |
| --- | --- |
| `wallets` | Materialized balance and optimistic `version` |
| `wager_transactions` | Business intent, status, failure code, reference link |
| `wallet_ledger_entries` | Append-only debits/credits; immutable triggers |
| `inbox_messages` | `(consumer_name, message_id)` redelivery dedup |
| `outbox_messages` | Transactional event outbox (`published_at`, `attempts`) |
| `schema_migrations` | Reversible migration bookkeeping |

Database-enforced invariants include non-negative balances, unique wallet per
`(player_id, currency)`, unique idempotency keys, unique
`(provider_id, external_transaction_id)`, at most one ledger entry per
`(transaction_id, wallet_id)`, at most one reversal per reference, and
balanced ledger arithmetic.

## Workers

| Worker | Responsibility |
| --- | --- |
| `ReferenceResolutionWorker` | Claims due `PENDING_REFERENCE` rows with `FOR UPDATE SKIP LOCKED`, retries or expires them |
| `OutboxPublisherWorker` | Leases due outbox rows, publishes to `wager-events.fifo`, backs off on failure |
| `WagerConsumerWorker` | Long-polls the wager queue, submits, deletes on success, leaves failures for DLQ |
| `ReconciliationWorker` | Keyset-scans wallets and compares materialized balance with the ledger sum |

All workers are safe to run in every instance. Outbox, reference and inbox
operations use `SKIP LOCKED` or unique constraints, so no advisory/global locks
are needed.

## Tests

```bash
bun run typecheck
bun run test:unit          # 73
bun run test:integration   # 39 (real Postgres + LocalStack)
bun run test:concurrency   # 3
```

Integration tests create and delete dedicated FIFO queues, park unrelated
outbox/pending rows, and assert exact business effects. The concurrency suite
covers two 80.00 bets against 100.00, 50 concurrent 10.00 bets (exactly 10
processed), and 10 identical idempotency keys (one effect, nine replays).

## Configuration

See `.env.example`. Key variables:

- `DATABASE_URL`, `PORT`, `LOG_LEVEL`
- `SQS_ENDPOINT`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- `SQS_QUEUE_WAGER`, `SQS_QUEUE_DLQ`, `SQS_QUEUE_EVENTS`
- `CONSUMER_ENABLED`, `SQS_CONSUMER_WAIT_SECONDS`, `SQS_CONSUMER_MAX_MESSAGES`
- `OUTBOX_ENABLED`, `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE`,
  `OUTBOX_BASE_DELAY_MS`, `OUTBOX_MAX_BACKOFF_MS`
- `REFERENCE_WORKER_ENABLED`, `REFERENCE_POLL_INTERVAL_MS`,
  `REFERENCE_BATCH_SIZE`, `REFERENCE_BASE_DELAY_MS`, `REFERENCE_BACKOFF_FACTOR`,
  `REFERENCE_MAX_ATTEMPTS`, `REFERENCE_TTL_MS`
- `RECONCILIATION_ENABLED`, `RECONCILIATION_INTERVAL_MS`,
  `RECONCILIATION_BATCH_SIZE`
- `SQS_VISIBILITY_TIMEOUT`, `SQS_MAX_RECEIVE_COUNT`

## Decision log

- PostgreSQL constraints and locks are the source of truth; no in-memory
  idempotency cache or distributed lock is trusted.
- Transactional outbox instead of a dual write to DB + queue.
- Per-wallet row locks instead of a global lock; `SKIP LOCKED` for queues of
  work so instances scale horizontally.
- Immutable ledger with database triggers; reconciliation is read-only.
- Decimal strings / `NUMERIC(19,2)` instead of floats.
- Reversible SQL migrations with a custom runner.
- At-least-once event delivery; consumers dedupe by `eventId`.

## Assumptions and divergences

- Authentication is a no-op `AuthGuard` with a `ProviderIdentityPort`
  extension point; provider identity/signature enforcement is not implemented.
- The SQS events queue has no downstream consumer in this scope; publishing is
  at-least-once and consumers must dedupe by `eventId`.
- Reconciliation reports divergences but does not repair them automatically.
- LocalStack stands in for AWS SQS; queue attributes and redrive behavior are
  exercised in tests.
- Rare deadlocks between a reversal and the reference worker are possible;
  HTTP maps `40P01`/`40001` to `503` and consumers retry.
