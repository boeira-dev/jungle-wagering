# PROGRESS

## Current phase

Phase 12 - Final review (DONE)

## Done

- Phase 1: foundation, health 200/200.
- Phase 2: Money VO + unit tests.
- Phase 3: reversible schema with all constraints/triggers + migration integration test.
- Phase 4: Wallet, WagerTransaction, WalletLedgerEntry, Inbox/Outbox, integration events, canonical payload hash. Unit suite 73/73.
- Phase 5:
  - `POST /wallets` inserts wallet + optional OPENING transaction + ledger + outbox atomically.
  - `POST /wagering/transactions` submit use case: payload hash, `ON CONFLICT DO NOTHING` idempotency reservation, replay with original result, wallet `FOR UPDATE`, BET/WIN/LOSS/REFUND/ROLLBACK rules, reference validation (kind/identity/round/amount), ALREADY_REVERSED, PENDING_REFERENCE (5s backoff base, attempts), ledger + outbox in one SQL transaction.
  - Inbox dedup for SQS source, marked processed in the same transaction.
  - Standard error body `{code,message,failureCode?,retryable}` and status mapping (200/201/202/400/404/409/422/503).
  - Metrics service and exception filter (lock-conflict/transient classification).
  - Auth guard no-op + ProviderIdentityPort extension point.
  - Tests: unit 73, integration 24, concurrency 3 (2x80, 50 parallel 10.00 on 100.00, 10 identical idempotency key).
- Phase 6:
  - `processNextPendingReference` claims one due row per transaction with `FOR UPDATE SKIP LOCKED`, so multiple instances can drain concurrently without double processing.
  - Exponential backoff `base * factor^attempts` (5s, 10s, 20s, ...), capped by TTL; max 8 attempts and 15-minute TTL.
  - On reference arrival the normal reversal path runs (wallet lock, validation, ledger, outbox). A still-missing reference is rescheduled; expiry marks `REJECTED`/`REFERENCE_NOT_FOUND_EXPIRED` with the observed balance and a rejected event.
  - `ReferenceResolutionWorker` polls every 500ms, drains up to 100 rows per tick, has a per-instance overlap guard and starts only when `REFERENCE_WORKER_ENABLED` is true.
  - Tests: unit 73, integration 29 (backoff, late reference, max attempts, TTL, 20 refunds across 5 concurrent workers with exactly one processed), concurrency 3.
  - Manual HTTP flow verified: REFUND without reference -> 202, BET arrives -> worker -> 200 replay with the refunded balance.
- Fixed during Phase 5:
  - `Money.isPositive()` treated `0` as positive (decimal.js sign semantics); zero wallets created an empty OPENING.
  - Raw SQL used `getConnection().execute` which escaped the transaction and exhausted the pool under 50 concurrent requests; switched to context-aware `em.execute`.

- Phase 7:
  - `OutboxPublisherWorker` polls every 200ms and claims due rows atomically with `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`, leasing them for 30s so multiple instances never claim the same row.
  - Publishes envelopes to `wager-events.fifo` with `MessageGroupId=aggregateId` and `MessageDeduplicationId=eventId`, then marks `published_at`; failures increment `attempts` and back off exponentially (1s base, 60s cap) via `next_attempt_at`.
  - Emits `outbox_publish_failures_total`, refreshes the `outbox_lag_seconds` gauge, and is at-least-once (consumers must dedupe by eventId).
  - Tests: unit 73, integration 32 (real SQS publish/receive, failure/backoff, two publishers claiming each row exactly once), concurrency 3.
  - Manual flow verified: 19 unpublished rows drained on startup and a new wallet's two events received from `wager-events.fifo`.

- Phase 8:
  - `WagerConsumerWorker` long-polls `wager-transactions.fifo` (20s wait, 10 messages) and feeds each body through the same submit use case as HTTP, with `source=sqs`, `MessageId` as the default idempotency key and `MessageGroupId` as the correlation fallback.
  - Success (processed, replay, pending reference or business rejection) deletes the message; parse errors, idempotency conflicts and transient failures leave it for redelivery so the redrive policy moves it to `wager-transactions-dlq.fifo` after 5 receives.
  - Inbox rows are written in the same commit as the business effect, so a crash after commit but before delete replays safely; `wager_retries_total{queue=wager}` and `wager_dlq_messages_total` track redeliveries.
  - Tests: unit 73, integration 37 (valid message + inbox, duplicate business transaction replayed once, business rejection acked, poison message redelivered, 20 messages across two concurrent consumers exactly once), concurrency 3.
  - Manual flow verified: SQS BET 25.00 processed -> wallet 75.00/v2, duplicate replayed without a second debit, outbox events published, invalid message reached the DLQ after 5 receives.

- Phase 9:
  - `ReconciliationWorker` periodically scans wallets with keyset pagination and reconstructs each balance from the immutable ledger (`SUM(CREDIT) - SUM(DEBIT)`), comparing it with the materialized `wallets.balance`.
  - Divergences are logged with wallet/currency/amounts and counted in `reconciliation_divergences_total`; the job is read-only and never repairs data.
  - `GET /metrics` exposes the prom-client registry (HTTP 200, `text/plain`), including outbox lag/failures, retries, DLQ, replays and reconciliation counters.
  - Tests: unit 73, integration 39 (divergence reported and cleared after correction, zero-balance wallet consistent), concurrency 3.
  - Manual: `/metrics` returned 201 lines of metrics; reconciliation checked 4 wallets with 0 divergences.

- Phase 10:
  - `scripts/load-test.ts` spreads HTTP traffic round-robin across `BASE_URLS` (default one instance).
  - Three instances (13000-13002) sharing Postgres and LocalStack: 50 concurrent 10.00 bets on a 100.00 wallet produced exactly 10 `200 PROCESSED` and 40 `422 INSUFFICIENT_FUNDS`, final balance `0.00`/version 11, no 5xx.
  - 10 concurrent submissions with one idempotency key produced one effect, nine replays, final balance `90.00`; reusing the key with a different payload returned `409`.
  - The three outbox publishers drained every row to `published_at` (pending 0) without duplicate effects.
  - `SIGTERM` stopped one instance cleanly while the other two stayed ready; the final app was restarted as a single instance on 13000.
  - `SqsService` now destroys the AWS SDK client on shutdown so the process can exit promptly.

- Phase 11:
  - Added `README.md`: architecture, API and status mapping, SQS input contract, data model/invariants, worker behavior, operations/DLQ runbook, configuration, test commands, decision log and assumptions/divergences.
  - Expanded `.env.example` with every worker/tuning variable.
  - Removed the stale duplicate `src/unit` test copies; `test/unit` is the canonical suite (73 tests).

- Phase 12:
  - Final sweep: `tsc --noEmit` clean; unit 73, integration 39, concurrency 3, all passing.
  - Live instance on 13000: `/health/live`, `/health/ready` and `/metrics` all 200; outbox pending 0; reconciliation repeatedly checked 6 wallets with 0 divergences.
  - Queues: `wager-transactions.fifo` 0 visible/0 in-flight, DLQ 0, `wager-events.fifo` 71 published messages (no downstream consumer by design).
  - Git tree clean with one commit per phase (12 commits; no remote required).

## Next

None - project delivered.

## Known issues

- The SQS events queue has no downstream consumer in this scope; delivery is at-least-once and consumers must dedupe by eventId.
- Authentication is a no-op guard with a ProviderIdentityPort extension point; provider identity is not enforced yet.
- Lock ordering can produce rare deadlocks between a reversal and the reference worker; consumers must retry (deadlock codes 40P01/40001) and HTTP maps them to 503.
