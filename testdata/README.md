# Datos de prueba / fuente cruda

## Fuente principal: API → `raw_transactions`

```bash
python3 etl/emit_raw_transactions.py populate --count 5000
python3 etl/emit_raw_transactions.py stress --tps 100 --duration 20
curl -s http://localhost:3000/api/v1/raw-transactions/stats
```

Campos UAFE: `type_code` + `type_name` (37 Nota de Débito, 03 Depósito, 71 Retiro…), `nature_code`, `product_code`, `status` COMPLETED|REJECTED, `reject_reason`.

Infraestructura → tabla `infra_exceptions` (no entra aquí).

## ETL desde la BD (fuente real)

Lee `raw_transactions` del banco API, limpia (UAFE + sin infra), escribe artefactos en `testdata/` y **carga `ai-db`** (`ai_transactions` + `ai_prompt_contexts`).

```bash
# Local (stack Compose ya arriba: postgres :5432, ai-db :5433)
DATABASE_URL=postgresql://smartbancs:smartbancs@localhost:5432/smartbancs \
AI_DATABASE_URL=postgresql://ai:ai@localhost:5433/smartbancs_ai \
python3 etl/transform.py --from-db

# O Compose (red interna; también corre al hacer `up` porque `ai` depende de él)
docker compose run --rm etl
```

Solo CSV legacy (sin leer BD del banco):

```bash
AI_DATABASE_URL=postgresql://ai:ai@localhost:5433/smartbancs_ai \
python3 etl/transform.py testdata/raw_transactions.csv
```

Salidas: `clean_transactions.json`, `prompt_contexts.json`, `rejected.csv`, `excluded_infra.csv`. La IA consume **solo** `ai-db`.
