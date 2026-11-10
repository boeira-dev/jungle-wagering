export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super('INVALID_MONEY', message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(left: string, right: string) {
    super('CURRENCY_MISMATCH', `Currency mismatch: ${left} != ${right}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(available: string, requested: string) {
    super('INSUFFICIENT_FUNDS', `Insufficient funds: available ${available}, requested ${requested}`);
  }
}

export class UnbalancedLedgerEntryError extends DomainError {
  constructor() {
    super('UNBALANCED_LEDGER_ENTRY', 'Ledger entry is not balanced');
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(from: string, to: string) {
    super('INVALID_TRANSACTION_STATE', `Invalid transaction state transition: ${from} -> ${to}`);
  }
}

export class InvalidKindError extends DomainError {
  constructor(message: string) {
    super('INVALID_KIND', message);
  }
}

export class InvalidReferenceError extends DomainError {
  constructor(message: string) {
    super('INVALID_REFERENCE', message);
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor() {
    super('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different payload');
  }
}

export class WalletNotFoundError extends DomainError {
  constructor(walletId: string) {
    super('WALLET_NOT_FOUND', `Wallet not found: ${walletId}`);
  }
}

export class ReferenceNotFoundError extends DomainError {
  constructor() {
    super('REFERENCE_NOT_FOUND', 'Reference transaction was not found');
  }
}

export class InvalidWalletError extends DomainError {
  constructor(message: string) {
    super('INVALID_WALLET', message);
  }
}

export class WalletAlreadyExistsError extends DomainError {
  constructor(playerId: string, currency: string) {
    super(
      'WALLET_ALREADY_EXISTS',
      `Wallet already exists for player ${playerId} in ${currency}`,
    );
  }
}
