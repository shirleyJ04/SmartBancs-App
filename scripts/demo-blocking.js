#!/usr/bin/env node
const path = require('path');
module.paths.push(path.join(__dirname, '..', 'services', 'app', 'node_modules'));
const { Client } = require('pg');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL es obligatorio');
  process.exit(1);
}

async function main() {
  const locker = new Client({ connectionString: databaseUrl, application_name: 'smartbancs-locker' });
  const waiter = new Client({ connectionString: databaseUrl, application_name: 'smartbancs-waiter' });
  const observer = new Client({ connectionString: databaseUrl, application_name: 'smartbancs-observer' });
  await locker.connect();
  await waiter.connect();
  await observer.connect();

  await locker.query('BEGIN');
  await locker.query("SET LOCAL lock_timeout = '15s'");
  const locked = await locker.query(
    "SELECT id, account_number, balance FROM accounts WHERE account_number = 'ACC-001' FOR UPDATE",
  );
  console.log(JSON.stringify({ step: 'lock_held', account: locked.rows[0] }));

  await waiter.query('BEGIN');
  await waiter.query("SET LOCAL lock_timeout = '8s'");

  const waitPromise = waiter.query(
    "SELECT id, account_number FROM accounts WHERE account_number = 'ACC-001' FOR UPDATE",
  );

  await sleep(1500);
  const diag = await observer.query(`
    SELECT
      blocked.pid AS blocked_pid,
      left(blocked.query, 180) AS blocked_query,
      blocking.pid AS blocking_pid,
      left(blocking.query, 180) AS blocking_query,
      pg_blocking_pids(blocked.pid) AS blocking_pids
    FROM pg_stat_activity blocked
    JOIN pg_stat_activity blocking ON blocking.pid = ANY (pg_blocking_pids(blocked.pid))
  `);
  console.log(JSON.stringify({ step: 'diagnosis', rows: diag.rows }, null, 2));

  await locker.query('ROLLBACK');
  try {
    await waitPromise;
    await waiter.query('ROLLBACK');
    console.log(JSON.stringify({ step: 'recovered', action: 'lock_released_waiter_completed' }));
  } catch (error) {
    console.log(JSON.stringify({ step: 'recovered', action: 'waiter_timed_out', error: error.message }));
    await waiter.query('ROLLBACK').catch(() => undefined);
  }

  await locker.end();
  await waiter.end();
  await observer.end();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
