import { createHash, randomInt } from 'crypto';
import { FIRST_NAMES, LAST_NAMES } from './names';

export const DEMO_ACCOUNTS = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    accountNumber: 'ACC-001',
    holderName: 'Ana Ruiz',
    balance: '10000.00',
    currency: 'USD',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    accountNumber: 'ACC-002',
    holderName: 'Bruno Díaz',
    balance: '5000.00',
    currency: 'USD',
  },
  {
    id: '33333333-3333-3333-3333-333333333333',
    accountNumber: 'ACC-003',
    holderName: 'Carla Méndez',
    balance: '2500.00',
    currency: 'USD',
  },
  {
    id: '44444444-4444-4444-4444-444444444444',
    accountNumber: 'ACC-004',
    holderName: 'Diego Soto',
    balance: '100.00',
    currency: 'USD',
  },
];

export type GeneratedAccount = {
  id: string;
  accountNumber: string;
  holderName: string;
  balance: string;
  currency: string;
};

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
}

function accountIdFromNumber(accountNumber: string) {
  const hex = createHash('sha1').update(`smartbancs:${accountNumber}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function formatAccountNumber(n: number) {
  return `ACC-${String(n).padStart(3, '0')}`;
}

function randomBalance(): string {
  const cents = randomInt(100, 100_000_000 + 1);
  return (cents / 100).toFixed(2);
}

export function generateUniqueAccounts(total = 10_000): GeneratedAccount[] {
  const used = new Set(DEMO_ACCOUNTS.map((account) => normalizeName(account.holderName)));
  const pairs: Array<[string, string]> = [];
  for (const first of FIRST_NAMES) {
    for (const last of LAST_NAMES) {
      const full = `${first} ${last}`;
      if (!used.has(normalizeName(full))) {
        pairs.push([first, last]);
      }
    }
  }

  for (let i = pairs.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    const current = pairs[i];
    const swap = pairs[j];
    if (current && swap) {
      pairs[i] = swap;
      pairs[j] = current;
    }
  }

  const needed = total - DEMO_ACCOUNTS.length;
  if (pairs.length < needed) {
    throw new Error(`No hay suficientes combinaciones únicas: ${pairs.length} < ${needed}`);
  }

  const generated: GeneratedAccount[] = DEMO_ACCOUNTS.map((account) => ({ ...account }));
  for (let i = 0; i < needed; i += 1) {
    const pair = pairs[i];
    if (!pair) {
      throw new Error('Par de nombre agotado');
    }
    const [first, last] = pair;
    const holderName = `${first} ${last}`;
    used.add(normalizeName(holderName));
    const n = i + 5;
    const accountNumber = formatAccountNumber(n);
    generated.push({
      id: accountIdFromNumber(accountNumber),
      accountNumber,
      holderName,
      balance: randomBalance(),
      currency: 'USD',
    });
  }

  const uniqueNames = new Set(generated.map((account) => normalizeName(account.holderName)));
  if (uniqueNames.size !== generated.length) {
    throw new Error('Se generaron nombres completos repetidos');
  }
  return generated;
}
