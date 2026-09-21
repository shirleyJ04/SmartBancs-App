import { createHash } from 'crypto';
import Decimal from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

export function parseAmount(value: string): Decimal {
  const normalized = value.trim();
  if (!AMOUNT_PATTERN.test(normalized)) {
    throw new MoneyError('INVALID_AMOUNT', 'El monto debe ser un decimal positivo con hasta 2 decimales');
  }
  const amount = new Decimal(normalized);
  if (amount.lte(0)) {
    throw new MoneyError('INVALID_AMOUNT', 'El monto debe ser mayor que cero');
  }
  return amount;
}

export function formatMoney(value: Decimal | string): string {
  return new Decimal(value).toFixed(2);
}

export function requestHash(input: {
  fromAccount: string;
  toAccount: string;
  amount: string;
  currency: string;
}): string {
  const canonical = JSON.stringify({
    fromAccount: input.fromAccount.trim(),
    toAccount: input.toAccount.trim(),
    amount: formatMoney(parseAmount(input.amount)),
    currency: input.currency.trim().toUpperCase(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export class MoneyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MoneyError';
  }
}
