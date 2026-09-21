#!/usr/bin/env node
const samples = Number(process.env.SAMPLES ?? 20);
const baseUrl = process.env.API_URL ?? 'http://localhost:3000';

async function main() {
  const durations = [];
  for (let i = 0; i < samples; i += 1) {
    const started = Date.now();
    const response = await fetch(`${baseUrl}/api/v1/transfers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fromAccount: 'ACC-001',
        toAccount: 'ACC-002',
        amount: '1.00',
        currency: 'USD',
        idempotencyKey: `latency-${Date.now()}-${i}`,
      }),
    });
    const elapsed = Date.now() - started;
    durations.push(elapsed);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} en muestra ${i}`);
    }
  }
  durations.sort((a, b) => a - b);
  const percentile = (p) => durations[Math.min(durations.length - 1, Math.floor((p / 100) * durations.length))];
  const report = {
    samples,
    p50_ms: percentile(50),
    p95_ms: percentile(95),
    max_ms: durations[durations.length - 1],
    under_2000ms: durations.every((ms) => ms < 2000),
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
