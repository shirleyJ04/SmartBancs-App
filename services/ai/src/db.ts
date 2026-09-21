import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

const poolMax = Number(process.env.DB_POOL_MAX ?? 20);
const idleTimeoutMillis = Number(process.env.DB_POOL_IDLE_MS ?? 30_000);
const connectionTimeoutMillis = Number(process.env.DB_POOL_CONN_TIMEOUT_MS ?? 5_000);

export const pool = new Pool({
  connectionString: process.env.AI_DATABASE_URL,
  max: poolMax,
  idleTimeoutMillis,
  connectionTimeoutMillis,
  allowExitOnIdle: false,
});

pool.on('error', (err) => {
  console.error(JSON.stringify({ level: 50, service: 'smartbancs-ai', msg: 'pg pool error', err: String(err) }));
});

export function poolStats() {
  return {
    max: pool.options.max ?? poolMax,
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

export async function ensureSchema() {
  const sql = readFileSync(join(process.cwd(), 'sql', 'init.sql'), 'utf8');
  await pool.query(sql);
}

export type LedgerRow = {
  uid: string;
  account_number: string;
  type_code: string;
  nature_code: string;
  product_code: string;
  type_label: string;
  status: string;
  amount: string;
  currency: string;
  booked_on: string;
  month: string;
  counterpart_name: string;
  category: string;
};

export type StoredContext = {
  account_number: string;
  as_of_month: string;
  compare_month: string;
  current_total: string;
  previous_total: string;
  total_ratio: string | null;
  rejected_cards: number;
  counterparts: string[];
  categories: Record<string, { current: number; previous: number; ratio: number | null }>;
  prompt: string;
};

export async function getLedger(accountNumber: string) {
  const result = await pool.query<LedgerRow>(
    `SELECT uid, account_number, type_code, nature_code, product_code, type_label,
            status, amount::text, currency, booked_on::text, month, counterpart_name, category
     FROM ai_transactions
     WHERE account_number = $1
     ORDER BY booked_on`,
    [accountNumber],
  );
  return result.rows;
}

export async function getContext(accountNumber: string) {
  const result = await pool.query<StoredContext>(
    `SELECT account_number, as_of_month, compare_month, current_total::text, previous_total::text,
            total_ratio::text, rejected_cards, counterparts, categories, prompt
     FROM ai_prompt_contexts
     WHERE account_number = $1`,
    [accountNumber],
  );
  return result.rows[0] ?? null;
}

export async function saveAdvice(input: {
  id: string;
  accountNumber: string;
  correlationId?: string;
  category: string;
  message: string;
  promptUsed: string;
  source?: string;
  model?: string | null;
}) {
  await pool.query(
    `INSERT INTO ai_advices (id, account_number, correlation_id, category, message, prompt_used, source, model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.id,
      input.accountNumber,
      input.correlationId ?? null,
      input.category,
      input.message,
      input.promptUsed,
      input.source ?? 'rules',
      input.model ?? null,
    ],
  );
}

export async function listAdvices(accountNumber: string) {
  const result = await pool.query(
    `SELECT id, account_number, correlation_id, category, message, prompt_used, source, model, created_at
     FROM ai_advices
     WHERE account_number = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [accountNumber],
  );
  return result.rows;
}

export async function stats() {
  const [tx, ctx, adv] = await Promise.all([
    pool.query('SELECT count(*)::int AS n FROM ai_transactions'),
    pool.query('SELECT count(*)::int AS n FROM ai_prompt_contexts'),
    pool.query('SELECT count(*)::int AS n FROM ai_advices'),
  ]);
  return {
    transactions: tx.rows[0]?.n ?? 0,
    promptContexts: ctx.rows[0]?.n ?? 0,
    advices: adv.rows[0]?.n ?? 0,
  };
}
