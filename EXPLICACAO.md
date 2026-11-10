# Jungle Wagering - Explicação completa do projeto

Este documento registra **o que foi construído**, **como reproduzir** e **por que
cada decisão foi tomada**. Ele foi escrito para quem precisa entender, auditar ou
recriar o projeto do zero.

O projeto foi desenhado para ser reproduzido em qualquer host com Docker e Bun,
sem depender de usuário, IP ou caminho específico. O histórico git tem um commit
por fase; nenhum remote é obrigatório para executar.

---

## 1. Resumo executivo

Foi construído um **Distributed Wagering Processor** para iGaming: um serviço que
recebe apostas e transações por **HTTP** e por **SQS**, aplica os efeitos
financeiros em **PostgreSQL**, mantém um **ledger imutável**, garante
**idempotência**, publica **eventos de integração** por **outbox transacional**,
resolve **referências tardias**, consome a fila de apostas com **deduplicação de
inbox** e **DLQ**, e reconcilia continuamente o saldo materializado com o ledger.

Principais números do estado final:

- **12 commits**, um por fase.
- **73 testes unitários**, **39 testes de integração** (Postgres real + LocalStack)
  e **3 testes de concorrência**, todos passando.
- **3 instâncias** da aplicação testadas ao mesmo tempo, sem over-spend, sem
  lost update e sem duplicidade de efeitos.
- Aplicação em execução na porta `13000`, com `/health/live`, `/health/ready` e
  `/metrics` respondendo `200`.
- Outbox pendente `0`; reconciliação com `0` divergências; DLQ vazia.

---

## 2. Ambiente e topologia

### Host de execução

O projeto pode rodar localmente ou em um host remoto. Os exemplos usam
`127.0.0.1` e assumem que a aplicação, o PostgreSQL e o LocalStack estão no mesmo
host. Se a aplicação estiver em outro host, ajuste `DATABASE_URL`, `SQS_ENDPOINT`
e `BASE_URLS`.

### Portas

| Serviço | Porta no host |
| --- | --- |
| PostgreSQL 16 | `15432` |
| LocalStack SQS | `14566` |
| Aplicação (instância 1) | `13000` |
| Aplicação (instâncias extras) | `13001`, `13002` |

As portas são altas e configuráveis para evitar conflito com outros serviços.
Ajuste o `.env` e o mapeamento do compose se necessário.

### Containers e isolamento

O `docker-compose.yml` usa:

- `name: jungle_wagering` e sempre `docker compose -p jungle_wagering`.
- Containers `jw_postgres` e `jw_localstack`.
- Rede `jw_net`.
- Volumes `jw_pgdata` e `jw_localstack`.


Regra de segurança: nunca executar `docker system prune` ou `docker compose down`
global. Limpeza permitida e escopada:

```bash
docker compose -p jungle_wagering down -v
```

---

## 3. O que o sistema faz

Fluxo resumido:

```text
HTTP  --------------------\
                           >-- SubmitWagerUseCase --> PostgreSQL
SQS wager-transactions.fifo/        (uma transação SQL com:
                                     wallets,
                                     wager_transactions,
                                     wallet_ledger_entries,
                                     inbox_messages,
                                     outbox_messages)
                                              |
                                              +--> OutboxPublisherWorker --> wager-events.fifo

ReferenceResolutionWorker --> retenta/expira transações PENDING_REFERENCE
WagerConsumerWorker       --> SQS -> mesmo use case, inbox dedup, DLQ
ReconciliationWorker      --> saldo da wallet vs SUM(ledger CREDIT - DEBIT)
```

Regras de negócio principais:

- Tipos externos aceitos: `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`.
  `OPENING` é interno.
- `REFUND` só referencia `BET`.
- `ROLLBACK` pode referenciar `BET`, `WIN` ou `REFUND`.
- Reversões devem ter o mesmo valor da referência.
- Referência ausente cria `PENDING_REFERENCE` e é retentada com backoff
  exponencial.
- Referência que não chega em 8 tentativas ou 15 minutos é rejeitada com
  `REFERENCE_NOT_FOUND_EXPIRED`.
- Replay de uma submissão retorna o resultado original e não duplica efeitos.
- Mesma chave de idempotência com payload diferente retorna `409`.
- Saldo nunca pode ficar negativo.
- Ledger é append-only: `UPDATE`, `DELETE` e `TRUNCATE` são bloqueados por
  triggers.

---

## 4. Stack e estrutura

Stack:

- Bun 1.4.
- TypeScript strict.
- NestJS 11.
- PostgreSQL 16.
- MikroORM 6.
- SQS via LocalStack 3.8 (local).
- decimal.js.
- zod.
- prom-client.

Estrutura principal:

```text
src/
  main.ts                    bootstrap e shutdown hooks
  app.module.ts              composição raiz
  config.ts                  configuração por variáveis de ambiente
  domain/                    regras puras (Money, Wallet, WagerTransaction, Ledger, eventos)
  application/
    wallet/                  criação e leitura de wallets
    wagering/                controller HTTP, DTOs, use case, reference worker, consumer SQS
    events/                  outbox e publisher
    reconciliation/          reconciliação wallet x ledger
  infrastructure/
    database/                MikroORM, runner de migrations, migration 001
    persistence/             EntitySchema e mappers
    sqs/                     cliente SQS e bootstrap de filas
  observability/             métricas e endpoint /metrics
  health/                    /health/live e /health/ready
  common/                    guard, filtro de exceções, contratos comuns
test/
  unit/                      testes de domínio
  integration/               Postgres real + LocalStack
  concurrency/               cenários concorrentes
  support/                   contexto de teste e helpers
scripts/
  migrate.ts                 up / down / down-all
  test-setup.ts              prepara bancos de teste
  load-test.ts               teste multi-instância via HTTP
  db-init.sql                bancos auxiliares de teste
  localstack-init.sh         criação inicial das filas
README.md                    documentação principal
PROGRESS.md                  diário de fases
docker-compose.yml           Postgres + LocalStack
.env.example                 todas as variáveis
```

---

## 5. Linha do tempo: o que foi feito em cada fase

### Fase 1 - Fundação

- Projeto Bun + TypeScript strict + NestJS 11.
- Compose com Postgres e LocalStack em portas altas, com limites de memória/CPU.
- Conexão MikroORM, health checks `/health/live` e `/health/ready`.
- Serviço SQS com criação idempotente das filas FIFO:
  `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e
  `wager-events.fifo`.

Motivo: ter ambiente isolado, reproduzível e sem conflito com os serviços
existentes, com health checks prontos para orquestração.

### Fase 2 - Value Object de dinheiro

- `Money` com decimal.js, string, escala 2, sem `number`/float.
- Testes unitários cobrindo parsing, soma, subtração, comparação e serialização.

Motivo: erro de ponto flutuante em dinheiro é inaceitável. A representação
canônica é string decimal, e o banco usa `NUMERIC(19,2)`.

### Fase 3 - Schema reversível e invariantes no banco

- Migration `001-initial` com `up` e `down`.
- Runner próprio com tabela `schema_migrations`.
- Constraints e triggers:
  - saldo `>= 0`;
  - wallet única por `(player_id, currency)`;
  - idempotency key única;
  - `(provider_id, external_transaction_id)` único;
  - no máximo um ledger por `(transaction_id, wallet_id)`;
  - no máximo uma reversão por referência (índice único parcial);
  - ledger imutável (bloqueia `UPDATE`, `DELETE`, `TRUNCATE`);
  - aritmética do ledger balanceada.
- Testes de integração do schema (10 testes).

Motivo: o banco é a última linha de defesa. Mesmo com bug de aplicação, as
invariantes financeiras não podem ser violadas.

### Fase 4 - Domínio

- Agregados `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`,
  `OutboxMessage`.
- Eventos de integração, hash canônico de payload, enums e erros de domínio.
- Suíte unitária consolidada em 73 testes.

Motivo: concentrar regras no domínio, sem dependência de HTTP/banco, para testar
rápido e reutilizar no HTTP, SQS e workers.

### Fase 5 - Submissão HTTP transacional

- `POST /wallets`: wallet + OPENING + ledger + outbox no mesmo commit.
- `POST /wagering/transactions`: hash do payload, reserva de idempotência com
  `ON CONFLICT DO NOTHING`, replay do resultado original, lock pessimista da
  wallet, regras de BET/WIN/LOSS/REFUND/ROLLBACK, validação de referência,
  `ALREADY_REVERSED`, `PENDING_REFERENCE`, ledger + outbox na mesma transação.
- Inbox para SQS marcado como processado no mesmo commit.
- Envelope de erro padrão, mapeamento de status, métricas, guard no-op.
- Testes: 24 de integração e 3 de concorrência.

Correções importantes desta fase:

1. `Money.isPositive()` tratava `0` como positivo. Isso criava transação OPENING
   vazia em wallet zerada. Corrigido para comparação estrita com zero.
2. Uso de `getConnection().execute(...)` executava SQL **fora da transação**, em
   outra conexão do pool. Sob 50 requisições concorrentes isso esgotava o pool e
   travava. Corrigido para `em.execute(...)`/`trx.execute(...)`, que respeitam o
   contexto transacional do MikroORM.
3. `AuthGuard` injetava uma interface apagada em runtime. Corrigido com
   `@Inject(PROVIDER_IDENTITY_PORT)`.

Motivo das decisões: lock por wallet permite concorrência entre wallets sem lock
global; idempotência no banco sobrevive a crash e múltiplas instâncias; ledger +
outbox no mesmo commit elimina inconsistência entre efeito e evento.

### Fase 6 - Resolução de referências

- `PENDING_REFERENCE` quando a referência ainda não existe.
- Worker com `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1`, processando uma linha
  por transação.
- Backoff exponencial `base * fator^tentativas` (5s, 10s, 20s, ...), limitado
  pelo TTL.
- Máximo de 8 tentativas / 15 minutos; depois `REJECTED` com
  `REFERENCE_NOT_FOUND_EXPIRED`, saldo observado e evento de rejeição.
- `scheduleReferenceRetry` para uma linha que já está `PENDING_REFERENCE`, pois
  `markPendingReference` não permite a transição PENDING_REFERENCE -> PENDING_REFERENCE.
- Testes: backoff, referência tardia, máximo de tentativas, TTL e 20 refunds com
  5 workers concorrentes (exatamente 1 processado).

Motivo: não bloquear a submissão esperando a referência; resolver de forma
assíncrona, segura e com limite claro de tempo.

### Fase 7 - Outbox publisher

- Worker a cada 200ms.
- Claim atômico:
  `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`.
- Lease de 30s para evitar que duas instâncias peguem a mesma linha.
- Publica em `wager-events.fifo` com:
  - `MessageGroupId = aggregate_id`;
  - `MessageDeduplicationId = eventId`.
- Sucesso marca `published_at`; falha incrementa `attempts` e agenda
  `next_attempt_at` com backoff exponencial (1s base, 60s teto).
- Métricas `outbox_publish_failures_total` e `outbox_lag_seconds`.
- Testes: publicação/recebimento real, falha + backoff, dois publishers
  concorrentes sem duplicidade.

Motivo: entrega at-least-once com atomicidade local. Se o processo cair depois do
envio e antes do commit, pode haver duplicata; consumidores deduplicam por
`eventId`.

### Fase 8 - Consumidor SQS

- `WagerConsumerWorker` faz long polling de `wager-transactions.fifo`
  (20s, até 10 mensagens).
- O corpo é o mesmo contrato do HTTP, com `idempotencyKey` e `correlationId`
  opcionais.
- Se `idempotencyKey` não vier, usa o `MessageId` do SQS.
- Sucesso (processado, replay, pending reference ou rejeição de negócio) deleta
  a mensagem.
- Erro de parse, conflito de idempotência ou falha transitória deixa a mensagem
  para redelivery.
- Após 5 receives, a redrive policy move para
  `wager-transactions-dlq.fifo`.
- Inbox `(consumer_name, message_id)` evita efeito duplicado em redelivery.
- Testes: mensagem válida + inbox, duplicata de negócio com replay único,
  rejeição de negócio com delete, mensagem inválida redeliverada, 20 mensagens
  com dois consumidores concorrentes.
- Verificação manual: BET via SQS processada, duplicata replay, inválida foi para
  a DLQ após 5 receives.

Motivo: HTTP e SQS compartilham o mesmo use case; rejeições de negócio não devem
envenenar a fila; erros permanentes vão para DLQ.

### Fase 9 - Reconciliação e métricas

- `ReconciliationWorker` a cada 60s, em lotes de 500, com keyset pagination por
  `id`.
- Consulta `wallet.balance` e `SUM(CREDIT) - SUM(DEBIT)` do ledger na mesma
  query.
- Divergências são logadas e contadas em `reconciliation_divergences_total`.
- Job é somente leitura; não repara dados.
- `GET /metrics` expõe o registry do prom-client.

Motivo: detectar drift entre saldo materializado e ledger sem risco de um job
automático mascarar problemas. Métricas permitem alertar.

### Fase 10 - Múltiplas instâncias e shutdown gracioso

- `scripts/load-test.ts` distribui requisições HTTP entre `BASE_URLS`.
- Teste com 3 instâncias (`13000`, `13001`, `13002`) no mesmo Postgres/LocalStack:
  - 50 apostas concorrentes de 10.00 em wallet de 100.00: exatamente 10
    processadas e 40 rejeitadas por saldo, saldo final 0.00.
  - 10 submissões com a mesma idempotency key: 1 efeito e 9 replays, saldo 90.00.
  - Mesma chave com payload diferente: `409`.
  - Outbox pending 0 nas 3 instâncias.
- `SIGTERM` parou uma instância enquanto as outras duas continuaram prontas.
- `SqsService` destrói o client AWS no shutdown para o processo encerrar rápido.

Motivo: comprovar que o desenho escala horizontalmente e que o shutdown não
deixa locks/recursos pendurados.

### Fase 11 - Documentação

- `README.md` com arquitetura, API, contrato SQS, modelo de dados, workers,
  operação, configuração, decisões, testes e limitações.
- `.env.example` ampliado com todas as variáveis.
- Remoção de cópias antigas de testes em `src/unit` (a suíte canônica é
  `test/unit`).

Motivo: reprodutibilidade e handoff.

### Fase 12 - Revisão final

- `typecheck` limpo.
- 73 unitários, 39 de integração, 3 de concorrência.
- Instância em `13000` com health e metrics `200`.
- Outbox pending 0; reconciliação 0 divergências.
- Filas: wager 0/0, DLQ 0, events com mensagens publicadas (sem consumidor por
  escopo).
- Repositório limpo, 12 commits, HEAD `4023a94`.

---

## 6. Modelo de dados e invariantes

| Tabela | Papel |
| --- | --- |
| `wallets` | Saldo materializado, `version`, `player_id`, `currency` |
| `wager_transactions` | Intenção de negócio, status, failure code, referência |
| `wallet_ledger_entries` | Débitos/créditos append-only, imutáveis |
| `inbox_messages` | Deduplicação de redelivery por `(consumer_name, message_id)` |
| `outbox_messages` | Eventos pendentes/publicados com tentativas |
| `schema_migrations` | Controle de migrations reversíveis |

Invariantes garantidas no banco:

- `wallets.balance >= 0`.
- Wallet única por `(player_id, currency)`.
- `idempotency_key` única.
- `(provider_id, external_transaction_id)` único.
- No máximo um ledger por `(transaction_id, wallet_id)`.
- No máximo uma reversão da mesma referência para o mesmo tipo (índice parcial).
- Ledger imutável (`UPDATE`/`DELETE`/`TRUNCATE` bloqueados).
- Aritmética do ledger balanceada.

---

## 7. Contratos

### HTTP

- `POST /wallets` -> `201` com wallet criada.
- `GET /wallets/:id` -> `200`, `400` para UUID inválido, `404` se não existir.
- `POST /wagering/transactions` -> exige `Idempotency-Key`; `X-Correlation-Id` é
  opcional.

| Status | Significado |
| --- | --- |
| `200` | processado ou replay idempotente |
| `202` | referência ainda não encontrada (`PENDING_REFERENCE`) |
| `400` | validação ou header de idempotência ausente |
| `404` | wallet não encontrada |
| `409` | conflito de idempotência/wallet |
| `422` | rejeição de negócio, com `failureCode` |
| `503` | erro transitório (deadlock/serialização), retryable |

Corpo de erro: `{ code, message, failureCode?, retryable }`.

### SQS de entrada

Fila `wager-transactions.fifo`. Corpo igual ao HTTP, com `idempotencyKey` e
`correlationId` opcionais. Sem `idempotencyKey`, o `MessageId` é usado.

- Sucesso: deleta.
- Falha de parse/validação/conflito/transitória: não deleta; SQS reentrega.
- 5 receives sem sucesso: DLQ `wager-transactions-dlq.fifo`.

### Eventos de saída

Fila `wager-events.fifo`. Envelope com:

- `eventId`, `eventType`, `version`, `aggregateId`, `correlationId`,
  `causationId`, `occurredAt`, `data`.

Principais tipos: `WagerTransactionProcessed`, `WagerTransactionRejected`,
`WagerTransactionPendingReference`, `WalletBalanceChanged`.

Entrega é at-least-once; consumidores devem deduplicar por `eventId`.

---

## 8. Decisões de arquitetura e por quê

| Decisão | Motivo | Alternativa rejeitada |
| --- | --- | --- |
| Dinheiro como string/NUMERIC(19,2) | Evitar erro de float; precisão e escala fixas | `number`, float |
| PostgreSQL como fonte da verdade | Durabilidade, constraints, transações | Cache/Redis como fonte |
| Lock pessimista por wallet | Serializa só a wallet; throughput entre wallets | Lock global, lock otimista sem retry |
| Idempotência no banco + hash do payload | Sobrevive a crash e múltiplas instâncias | Cache em memória |
| Outbox transacional | Efeito e evento no mesmo commit | Publicar direto (dual write) |
| Inbox dedup | Redelivery SQS sem efeito duplicado | Dedupe em memória |
| `FOR UPDATE SKIP LOCKED` | Várias instâncias drenam filas sem colisão | Advisory lock/global lock |
| At-least-once + dedupe | Sem transação distribuída; simples e robusto | Exactly-once |
| Reference worker com backoff/TTL | Não bloquear submissão; limite claro | Rejeitar imediatamente |
| Reconciliação read-only | Detecta sem mascarar/auto-reparar | Auto-repair |
| Migrations reversíveis | Rollback seguro | Somente `up` |
| Filas FIFO | Ordem por grupo | Standard queue |
| Portas altas + escopo `jungle_wagering` | Não conflitar com serviços existentes | Portas padrão/prune global |
| Testes com Postgres/LocalStack reais | Validar constraints e SQS de verdade | Mocks |

---

## 9. Como reproduzir do zero

Pré-requisitos: Docker 28+, Docker Compose v2 e Bun 1.4+.

### 9.1 Subir a infraestrutura

No diretório do projeto:

```bash
cd <pasta-do-projeto>
cp .env.example .env
docker compose -p jungle_wagering up -d
```

Aguarde `jw_postgres` e `jw_localstack` ficarem `healthy`:

```bash
docker ps --format '{{.Names}} {{.Status}}' | grep jw_
```

### 9.2 Aplicação

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun install
bun run migrate
bun run start
```

A aplicação cria as filas SQS no startup se elas não existirem. Também é possível
executar `bun run sqs:bootstrap`.

### 9.3 Verificação básica

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:13000/health/live
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:13000/health/ready
curl -s http://127.0.0.1:13000/metrics | head
```

### 9.4 Fluxo HTTP manual

```bash
W=$(curl -s -X POST http://127.0.0.1:13000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"player-demo","currency":"BRL","initialBalance":"100.00"}')
echo "$W"

ID=$(echo "$W" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

curl -s -X POST http://127.0.0.1:13000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'idempotency-key: demo-bet-1' \
  -d "{
    \"providerId\":\"provider-demo\",
    \"externalTransactionId\":\"ext-demo-1\",
    \"playerId\":\"player-demo\",
    \"walletId\":\"$ID\",
    \"roundId\":\"round-1\",
    \"kind\":\"BET\",
    \"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}
  }"
```

Repetir a mesma chamada com a mesma `Idempotency-Key` deve retornar replay
idempotente e não debitar de novo.

### 9.5 Fluxo SQS manual

```bash
docker exec jw_localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id player-demo \
  --message-deduplication-id "dedupe-$(date +%s)" \
  --message-body '{
    "providerId":"provider-demo",
    "externalTransactionId":"ext-sqs-1",
    "playerId":"player-demo",
    "walletId":"'"$ID"'",
    "roundId":"round-1",
    "kind":"BET",
    "money":{"amount":"10.00","currency":"BRL"}
  }'
```

O consumidor da aplicação processa em até poucos segundos. Verifique o banco:

```bash
docker exec jw_postgres psql -U jungle -d jungle -tAc \
  "SELECT status, balance_after FROM wager_transactions WHERE external_transaction_id = 'ext-sqs-1'"
```

### 9.6 DLQ

```bash
docker exec jw_localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --max-number-of-messages 10
```

### 9.7 Testes

```bash
bun run typecheck
bun run test:unit
bun run test:integration
bun run test:concurrency
```

Os testes de integração usam o banco `jungle_test` e SQS real do LocalStack,
criando e removendo filas dedicadas por teste. O script `bun run test:setup`
prepara os bancos `jungle_test`, `jungle_test_mig` e `jungle_test_multi`.

### 9.8 Múltiplas instâncias

```bash
PORT=13000 bun run start &
PORT=13001 bun run start &
PORT=13002 bun run start &

BASE_URLS=http://127.0.0.1:13000,http://127.0.0.1:13001,http://127.0.0.1:13002 \
  bun run scripts/load-test.ts
```

Resultado esperado: cenário A com 10 processadas e 40 rejeitadas; cenário B com 1
efeito e 9 replays; cenário C com `409`.

### 9.9 Shutdown gracioso

```bash
kill -TERM <pid_da_instancia>
```

A instância deve encerrar em poucos segundos. As demais continuam respondendo.

### 9.10 Limpeza

```bash
docker compose -p jungle_wagering down -v
```

Nunca usar prune global nem `down` sem `-p jungle_wagering`.

---

## 10. Operação e diagnóstico

Health:

```bash
curl -s localhost:13000/health/live
curl -s localhost:13000/health/ready
```

Métricas:

```bash
curl -s localhost:13000/metrics
```

Métricas principais:

- `wager_transactions_total{status}`
- `wager_idempotent_replays_total`
- `wager_processing_seconds`
- `wager_lock_conflicts_total`
- `wager_retries_total{queue}`
- `wager_dlq_messages_total`
- `outbox_publish_failures_total`
- `outbox_lag_seconds`
- `reconciliation_divergences_total`

Banco:

```bash
docker exec jw_postgres psql -U jungle -d jungle -c \
  "SELECT status, count(*) FROM wager_transactions GROUP BY status"

docker exec jw_postgres psql -U jungle -d jungle -c \
  "SELECT count(*) FROM outbox_messages WHERE published_at IS NULL"
```

Logs da aplicação em execução manual:

```bash
tail -f <arquivo-de-log>
```

---

## 11. Problemas encontrados e correções

1. **SQL fora da transação**
   `getConnection().execute(...)` usava outra conexão do pool, fora do contexto
   transacional. Em 50 requisições concorrentes o pool esgotava e travava.
   Correção: `em.execute(...)`/`trx.execute(...)`, que usam o contexto do
   MikroORM.

2. **Zero tratado como positivo**
   `Money.isPositive()` retornava `true` para `0.00`, criando OPENING vazia em
   wallet zerada. Correção: comparação estrita (`greaterThan(0)`).

3. **Injeção de dependência com interface**
   O `AuthGuard` injetava uma interface que desaparece em runtime. Correção:
   `@Inject(PROVIDER_IDENTITY_PORT)`.

4. **Isolamento de testes**
   Arquivos de integração compartilham o banco `jungle_test`. Correção: helpers
   `parkAllPending`, `parkOutbox`, `isolateOutbox`, filas SQS dedicadas e
   asserções por IDs específicos.

5. **DeleteQueueCommand**
   O SDK exige `QueueUrl`, não `QueueName`. Corrigido nos testes.

6. **Serialização de FIFO em teste concorrente**
   Mensagens no mesmo `MessageGroupId` são serializadas. Para exercitar
   concorrência real, o teste usa um grupo por mensagem.

7. **Processo não encerrava no shutdown**
   O client SQS mantinha recursos. Correção: `SqsService.onModuleDestroy()`
   destrói o client.

8. **Transição de retry de referência**
   `markPendingReference` não permite PENDING_REFERENCE -> PENDING_REFERENCE.
   Correção: `scheduleReferenceRetry` para linhas já pendentes.

9. **Duplicata de evento em crash**
   Aceita por design (at-least-once). Consumidores deduplicam por `eventId`.

---

## 12. Limitações, assunções e divergências

- Autenticação é um guard no-op com o ponto de extensão `ProviderIdentityPort`;
  identidade/assinatura de provider ainda não é aplicada.
- A fila `wager-events.fifo` não tem consumidor neste escopo. A entrega é
  at-least-once e consumidores futuros devem deduplicar por `eventId`.
- A reconciliação apenas reporta divergências; não corrige automaticamente.
- LocalStack substitui o SQS da AWS no ambiente local.
- Deadlocks raros entre reversão e reference worker são possíveis; HTTP mapeia
  `40P01`/`40001` para `503` retryable e consumidores reentregam.
- O repositório pode ser mantido apenas localmente; para publicar, adicione um
  remote e faça push.

---

## 13. Estado final

Commits (um por fase, no repositório):

```text
672e452 phase 1: foundation (NestJS/Bun/TS strict, compose, DB, SQS, health)
6b35802 phase 2: money value object and unit tests
9ee4dce phase 3: reversible schema with DB-level financial constraints and triggers
c25b656 phase 4: domain aggregates, events and unit tests
4e9fba0 phase 5: transactional submit use case, wallet creation and concurrency tests
6b421ce phase 6: reference resolution worker with backoff, expiry and SKIP LOCKED draining
5253107 phase 7: outbox publisher with SKIP LOCKED leasing, retries and SQS delivery
d68c260 phase 8: sqs wager consumer with inbox dedup, retries and dlq
357c463 phase 9: reconciliation worker and prometheus metrics endpoint
715ed59 phase 10: multi-instance load test and graceful shutdown
c134c6d phase 11: documentation and environment reference
4023a94 phase 12: final review and handoff
```

Verificações finais:

- `tsc --noEmit` limpo.
- 73 unitários, 39 de integração, 3 de concorrência.
- Aplicação em `13000`; `/health/live`, `/health/ready` e `/metrics` em `200`.
- Outbox pendente `0`; reconciliação com `0` divergências.
- `wager-transactions.fifo` vazia; DLQ vazia; `wager-events.fifo` com 71 eventos
  publicados (sem consumidor por escopo).
- Git limpo; nenhum remote é obrigatório.

Comandos rápidos:

```bash
# subir
docker compose -p jungle_wagering up -d
bun run migrate && bun run start

# testar
bun run typecheck && bun run test:unit && bun run test:integration && bun run test:concurrency

# carga multi-instância
BASE_URLS=http://127.0.0.1:13000,http://127.0.0.1:13001,http://127.0.0.1:13002 bun run scripts/load-test.ts

# inspecionar
curl -s localhost:13000/metrics | head
docker exec jw_postgres psql -U jungle -d jungle -c "SELECT count(*) FROM outbox_messages WHERE published_at IS NULL"
```
