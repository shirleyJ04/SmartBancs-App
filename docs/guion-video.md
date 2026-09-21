# Guion de video demostrativo

1. `cp .env.example .env` y `docker compose up --build`. Health + UI :3000.
2. Transferencia ACC-001 → ACC-002. COMPLETED y saldos.
3. Misma idempotencyKey → 200 sin segundo débito; otro monto → 409.
4. ACC-004 monto alto → 422 NSF.
5. Esperar 1–2 s → recomendaciones (worker).
6. Transferir ACC-148 → recomendación con historial/%; contrastar NEED_MORE_DATA.
7. `GET /metrics` y `node scripts/demo-blocking.js`.
8. Importar colección Postman (`postman/`).
9. `docker compose down`.

No afirmar 10 000 TPS ni envío real a Bancs.
