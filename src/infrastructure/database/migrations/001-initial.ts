import type { Migration } from './types';

const up = `
CREATE TABLE wallets (
  id uuid PRIMARY KEY,
  player_id varchar(255) NOT NULL,
  currency char(3) NOT NULL,
  balance numeric(19,2) NOT NULL,
  version integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
  CONSTRAINT wallets_version_positive CHECK (version >= 1),
  CONSTRAINT wallets_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency)
);

CREATE TABLE wager_transactions (
  id uuid PRIMARY KEY,
  provider_id varchar(255) NOT NULL,
  external_transaction_id varchar(255) NOT NULL,
  idempotency_key varchar(512) NOT NULL,
  payload_hash char(64) NOT NULL,
  wallet_id uuid NOT NULL,
  player_id varchar(255) NOT NULL,
  round_id varchar(255),
  game_id varchar(255),
  kind varchar(16) NOT NULL,
  amount numeric(19,2) NOT NULL,
  currency char(3) NOT NULL,
  reference_external_transaction_id varchar(255),
  reference_transaction_id uuid,
  status varchar(24) NOT NULL,
  failure_code varchar(64),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  balance_after numeric(19,2),
  processed_at timestamptz,
  created_at timestamptz NOT NULL,
  CONSTRAINT wager_tx_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT wager_tx_external_unique UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT wager_tx_amount_non_negative CHECK (amount >= 0),
  CONSTRAINT wager_tx_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wager_tx_kind_valid CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  CONSTRAINT wager_tx_status_valid CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  CONSTRAINT wager_tx_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT wager_tx_balance_after_non_negative CHECK (balance_after IS NULL OR balance_after >= 0),
  CONSTRAINT wager_tx_reference_external_required CHECK (
    kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL
  ),
  CONSTRAINT wager_tx_reference_only_for_reversals CHECK (
    reference_transaction_id IS NULL OR kind IN ('REFUND','ROLLBACK')
  ),
  CONSTRAINT wager_tx_pending_reference_has_next_attempt CHECK (
    status <> 'PENDING_REFERENCE' OR next_attempt_at IS NOT NULL
  ),
  CONSTRAINT wager_tx_processed_is_complete CHECK (
    status <> 'PROCESSED' OR (balance_after IS NOT NULL AND processed_at IS NOT NULL)
  ),
  CONSTRAINT wager_tx_processed_reversal_has_reference CHECK (
    status <> 'PROCESSED' OR kind NOT IN ('REFUND','ROLLBACK') OR reference_transaction_id IS NOT NULL
  ),
  CONSTRAINT wager_tx_terminal_needs_failure_code CHECK (
    status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL
  )
);

CREATE INDEX wager_tx_reference_idx
  ON wager_transactions (provider_id, reference_external_transaction_id);
CREATE INDEX wager_tx_pending_reference_idx
  ON wager_transactions (next_attempt_at) WHERE status = 'PENDING_REFERENCE';
CREATE INDEX wager_tx_created_idx ON wager_transactions (created_at, id);
CREATE UNIQUE INDEX wager_tx_reversal_unique
  ON wager_transactions (reference_transaction_id, kind)
  WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED' AND reference_transaction_id IS NOT NULL;

CREATE TABLE wallet_ledger_entries (
  id uuid PRIMARY KEY,
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
  direction varchar(8) NOT NULL,
  amount numeric(19,2) NOT NULL,
  currency char(3) NOT NULL,
  balance_before numeric(19,2) NOT NULL,
  balance_after numeric(19,2) NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT','CREDIT')),
  CONSTRAINT ledger_amount_non_negative CHECK (amount >= 0),
  CONSTRAINT ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
  CONSTRAINT ledger_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ledger_transaction_wallet_unique UNIQUE (transaction_id, wallet_id),
  CONSTRAINT ledger_balanced CHECK (
    (direction = 'DEBIT' AND balance_after = balance_before - amount)
    OR (direction = 'CREDIT' AND balance_after = balance_before + amount)
  )
);
CREATE INDEX ledger_wallet_cursor_idx
  ON wallet_ledger_entries (wallet_id, created_at, id);

CREATE FUNCTION jw_forbid_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger_entries is append-only and immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jw_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION jw_forbid_ledger_mutation();

CREATE TRIGGER jw_ledger_no_truncate
  BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION jw_forbid_ledger_mutation();

CREATE TABLE inbox_messages (
  consumer_name varchar(128) NOT NULL,
  message_id varchar(255) NOT NULL,
  payload_hash char(64) NOT NULL,
  received_at timestamptz NOT NULL,
  processed_at timestamptz,
  PRIMARY KEY (consumer_name, message_id)
);

CREATE TABLE outbox_messages (
  id uuid PRIMARY KEY,
  aggregate_id varchar(255) NOT NULL,
  event_type varchar(128) NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  published_at timestamptz,
  CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0)
);
CREATE INDEX outbox_pending_idx
  ON outbox_messages (next_attempt_at) WHERE published_at IS NULL;
CREATE INDEX outbox_occurred_idx ON outbox_messages (occurred_at);
`;

const down = `
DROP TABLE IF EXISTS outbox_messages;
DROP TABLE IF EXISTS inbox_messages;
DROP TABLE IF EXISTS wallet_ledger_entries;
DROP FUNCTION IF EXISTS jw_forbid_ledger_mutation();
DROP TABLE IF EXISTS wager_transactions;
DROP TABLE IF EXISTS wallets;
`;

export const migration001Initial: Migration = {
  id: '001_initial',
  up,
  down,
};
