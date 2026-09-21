# Resultados medidos (entorno local)

Fecha: 2026-09-20. PostgreSQL 16 + API NestJS vía Docker Compose (`localhost:3000`). Docker Desktop en este host: **2 CPUs** asignados al motor.

## Pruebas de aceptación

`cd services/app && npm test`

9/9 OK: transferencia correcta, saldo insuficiente, idempotencia concurrente, conflicto de clave, cruces A→B/B→A, IA caída, recuperación del worker, diagnóstico de bloqueo, HTTP.

## Latencia de `POST /api/v1/transfers`

`SAMPLES=10 node scripts/measure-latency.js`

| Métrica | Valor |
| --- | --- |
| p50 | 5 ms |
| p95 | 46 ms |
| max | 46 ms |
| todas < 2000 ms | sí |

Camino de transferencia (ledger). No se afirma 10 000 TPS.

## Estrés de ingest crudo (`POST /api/v1/raw-transactions`)

`python3 etl/emit_raw_transactions.py stress` — contrato **1 POST = 1 TX**, respuesta 202 + cola `ingest_queue`.

| Objetivo | Duración | `acceptedTps` | Objetivo cumplido | `infra` | p50 / p95 |
| --- | --- | --- | --- | --- | --- |
| 500 | 10 s | 497 | sí | 0 | 1.0 / 8.5 ms |
| 1000 | 10 s | 994 | sí | 0 | 0.9 / 7.8 ms |
| 1500 | 15 s | 1493 | sí | 0 | 2.9 / 44.0 ms |
| 2000 | 15 s | 1990 | sí | 0 | 25.1 / 113.2 ms |
| 2500 | 15 s | 2288 | no (techo) | 0 | 56.5 / 142.9 ms |
| 10000 | 15 s | 2245 | no (techo) | 0 | 36.9 / 131.5 ms |

**Alcance local:** cumple de forma estable hasta **~2000 TPS**; el techo medido ronda **~2200–2300 `acceptedTps`** sin errores de infraestructura. Pedir 10 000 solo hace visible ese techo (`hitTpsTarget: false`), no un crash.

Recorrido de optimización (baseline ~1k → soft-ack + raw body ~2.2k) y mejoras posibles: [documento-tecnico.md §8.1–8.3](documento-tecnico.md).

## ETL

`DATABASE_URL=... AI_DATABASE_URL=... python3 etl/transform.py --from-db`

Lee `raw_transactions` del banco, limpia UAFE (sin infra), carga `ai-db`. Corrida 2026-09-20: **653 011** en `ai_transactions`, **17 713** prompts; 6 filas sucias rechazadas.
