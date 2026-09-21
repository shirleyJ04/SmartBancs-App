# SmartBancs App — Reto TCS NextGen Engineers

MVP de transferencias locales con outbox recuperable, IA (Gemini + reglas) asíncrona, ETL UAFE, observabilidad y Compose.

**Supuesto:** las cuentas demo son locales (`COMPLETED` = `COMMIT` en PostgreSQL). Bancs está **simulado**.

---

## Prerrequisitos

- Docker Desktop (o Docker Engine) + Docker Compose
- Puertos libres: **3000** (API), **3001** (IA), **5432** (Postgres API), **5433** (`ai-db`)
- Opcional: Python 3.12 (ETL/scripts fuera de Compose), Node.js 22 (pruebas)
- Opcional: `GEMINI_API_KEY` (sin clave, la IA usa reglas locales)

---

## Instalar y levantar

```bash
git clone https://github.com/JoelPiuri/SmartBancs-App.git
cd SmartBancs-App
cp .env.example .env
# Opcional: editar .env y pegar GEMINI_API_KEY=...

docker compose up --build
```

Al subir, Compose levanta Postgres, corre el ETL hacia `ai-db`, inicia API, worker e IA.

| Servicio | URL |
| --- | --- |
| API + UI | http://localhost:3000 |
| Health API | http://localhost:3000/health |
| Métricas | http://localhost:3000/metrics |
| IA | http://localhost:3001/health |

### Smoke test

```bash
curl -s http://localhost:3000/health

curl -s -X POST http://localhost:3000/api/v1/transfers \
  -H 'content-type: application/json' \
  -d '{
    "fromAccount":"ACC-001",
    "toAccount":"ACC-002",
    "amount":"25.00",
    "currency":"USD",
    "idempotencyKey":"demo-001"
  }'
```

Cuentas semilla fijas: `ACC-001` (10000), `ACC-002` (5000), `ACC-003` (2500), `ACC-004` (100). Para demo de IA con historial ETL: **ACC-148**.

---

## Colección Postman

Archivos en [`postman/`](postman/):

| Archivo | Uso |
| --- | --- |
| [SmartBancs.postman_collection.json](postman/SmartBancs.postman_collection.json) | Colección completa |
| [SmartBancs.local.postman_environment.json](postman/SmartBancs.local.postman_environment.json) | Environment local |

**Importar en Postman:**

1. Postman → **Import** → seleccionar ambos JSON.
2. Activar el environment **SmartBancs Local**.
3. Variables: `baseUrl=http://localhost:3000`, `aiUrl=http://localhost:3001`, `accountWithHistory=ACC-148`.

**Carpetas de la colección:**

1. Operación — health y `/metrics`
2. Cuentas — listado y recomendaciones (vía outbox)
3. Transferencias — idempotencia, NSF, demo ACC-148
4. Raw transactions — ingest 202 / stats
5. Infra exceptions — timeouts de plataforma
6. IA Gemini — ledger `ai-db`, recommend, `NEED_MORE_DATA`

Con el stack arriba (`docker compose up`), ejecutar en orden: Health → Crear transferencia → (esperar 1–2 s) → Recomendaciones; o IA Gemini → Recomendar ACC-148.

---

## Probar

```bash
# Con Compose arriba:
cd services/app
npm install
DATABASE_URL=postgresql://smartbancs:smartbancs@localhost:5432/smartbancs \
  npx prisma migrate deploy
npm test
```

## ETL a demanda

Compose ya ejecuta el ETL al arrancar. Para re-ejecutar:

```bash
docker compose run --rm etl
# o en el host:
python3 -m pip install -r etl/requirements.txt
DATABASE_URL=postgresql://smartbancs:smartbancs@localhost:5432/smartbancs \
AI_DATABASE_URL=postgresql://ai:ai@localhost:5433/smartbancs_ai \
python3 etl/transform.py --from-db
```

## Detener

```bash
docker compose down
# Borrar volúmenes (datos):
docker compose down -v
```

---

## Documentación

- [docs/documento-tecnico.md](docs/documento-tecnico.md) — diseño (teórico)
- [docs/declaracion-uso-ia.md](docs/declaracion-uso-ia.md)
- [docs/resultados-medidos.md](docs/resultados-medidos.md)
- [docs/presentacion-3min.md](docs/presentacion-3min.md) / [docs/guion-video.md](docs/guion-video.md)
- [testdata/README.md](testdata/README.md)

## Seguridad

Entorno local, sin autenticación, cuentas de demostración. No versionar `.env` ni claves reales.
