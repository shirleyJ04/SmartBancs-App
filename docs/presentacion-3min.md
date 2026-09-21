# Guion de exposición (3 minutos)

1. Problema: picos de quincena, Bancs no aguanta 10k consultas, IA no puede bloquear el débito.
2. Supuesto: cuentas demo locales; `COMPLETED` = COMMIT; Bancs simulado.
3. Transferencia: una TX, locks por id, idempotencia, éxito tras commit.
4. IA asíncrona: outbox; Gemini/reglas después del COMMIT (ACC-148 con %, NEED_MORE_DATA sin historial).
5. ETL UAFE → ai-db; soft-ack ingest ~2k TPS local (no 10k).
6. Incidente: logs = operación; diagnose-locks / demo-blocking = blocking_pid.
7. Cierre: Compose, pruebas, documento técnico.
