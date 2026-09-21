import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'smartbancs_' });

export const transfersTotal = new Counter({
  name: 'smartbancs_transfers_total',
  help: 'Transferencias procesadas',
  labelNames: ['status'] as const,
  registers: [registry],
});

export const transferErrorsTotal = new Counter({
  name: 'smartbancs_transfer_errors_total',
  help: 'Errores de transferencia por código',
  labelNames: ['code'] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'smartbancs_http_request_duration_seconds',
  help: 'Duración de peticiones HTTP',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

export const dbDeadlocksTotal = new Counter({
  name: 'smartbancs_db_deadlocks_total',
  help: 'Deadlocks detectados en transferencias',
  registers: [registry],
});

export const dbTimeoutsTotal = new Counter({
  name: 'smartbancs_db_timeouts_total',
  help: 'Timeouts de lock o statement en transferencias',
  registers: [registry],
});

export const aiCallsTotal = new Counter({
  name: 'smartbancs_ai_calls_total',
  help: 'Llamadas al servicio de IA',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const aiCallDuration = new Histogram({
  name: 'smartbancs_ai_call_duration_seconds',
  help: 'Duración de llamadas al servicio de IA',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

export const outboxEvents = new Counter({
  name: 'smartbancs_outbox_events_total',
  help: 'Eventos de outbox por estado final del ciclo',
  labelNames: ['status'] as const,
  registers: [registry],
});
