# Documento técnico — SmartBancs App

Documento de diseño exigido por el reto: arquitectura, decisiones técnicas, integración con Bancs, manejo del modelo de IA y respuesta al incidente simulado. Lo marcado como **(teórico)** en el enunciado se desarrolla aquí. Lo **práctico** vive en el repositorio (código, Compose, ETL, métricas, pruebas); el README indica cómo instalar, ejecutar, probar y detener.

---

## 1. Arquitectura y decisiones técnicas

### 1.1. Objetivo del MVP

SmartBancs App procesa transferencias en tiempo real entre cuentas de demostración y ofrece recomendaciones financieras por IA **sin bloquear** el flujo transaccional. Bancs es el core legado: robusto pero incapaz de absorber un volumen alto de consultas directas.

**Supuesto de autoridad (MVP):** las cuentas demo las administra este sistema (fuente de verdad local). `COMPLETED` = `COMMIT` en PostgreSQL (débito, crédito, registro y eventos de outbox). No implica autorización de Bancs. Si Bancs fuera la autoridad, harían falta reserva, confirmación asíncrona y conciliación; eso queda como evolución.

### 1.2. Componentes

| Componente | Rol |
| --- | --- |
| API NestJS | Recibe transferencias e ingest; valida; escribe ledger local |
| Worker NestJS | Drena outbox (IA / Bancs simulado) e `ingest_queue` |
| PostgreSQL (API) | Saldos, transferencias, outbox, fallos, raw |
| Servicio IA + `ai-db` | Inferencia Gemini (o reglas) sobre ledger ETL |
| ETL Python | Lote crudo → ledger limpio UAFE para la IA |
| Docker Compose | Un comando para levantar el entorno (IaC del MVP) |

### 1.3. Justificación del stack (rendimiento, seguridad, escalabilidad)

| Decisión | Rendimiento | Seguridad | Escalabilidad |
| --- | --- | --- | --- |
| NestJS + TypeScript | Un codebase API/worker; contratos claros | Validación tipada; menos errores de contrato | Réplicas horizontales del mismo binario |
| PostgreSQL + `SELECT FOR UPDATE` | ACID; timeouts `SET LOCAL`; deadlocks detectables | SQL parametrizado; `CHECK` de saldo | Pooler (PgBouncer), réplicas de lectura en evolución |
| `NUMERIC` + decimal.js | Precisión monetaria | Evita errores de redondeo en dinero | — |
| Outbox + worker | Transferencia &lt; 2 s sin esperar IA/Bancs | Aísla fallos externos del ledger | Backpressure y reintentos sin saturar el request |
| Compose | Arranque reproducible en local | Secretos en `.env` | Sustituible por K8s/Terraform en producción |
| Python/pandas (ETL) | Lote fuera del path de 2 s | Limpieza antes de alimentar la IA | Job batch independiente del API |

La libertad tecnológica del enunciado se ejerce así: el stack no es impuesto; cada pieza se elige por el caso (concurrencia, &lt; 2 s, IA no bloqueante, Bancs no saturado).

### 1.4. Flujo de una transferencia (diseño)

1. Cliente → `POST /transfers`.
2. TX corta: locks ordenados por `id`, validación de saldo, débito/crédito, outbox `AI_RECOMMEND` (+ `BANCS_SIMULATED`).
3. `COMMIT` → respuesta `COMPLETED` (sin llamar a Gemini ni a Bancs).
4. Worker consume outbox de forma asíncrona.

Concurrencia: orden estable de locks evita el deadlock clásico A↔B; idempotencia por clave única; reintentos limitados ante deadlock. Detalle en código (`transfers.service.ts`).

---

## 2. Bancs — estrategia de sincronización (teórico) · §3.2

Bancs no puede recibir 10 000 consultas/s directas. El outbox **desacopla** el request del cliente; **no reduce** por sí solo el volumen hacia el core.

### 2.1. Flujo propuesto (producción)

```
Cliente → SmartBancs (ledger local / reserva)
              │
              ├─ respuesta rápida al cliente
              │
              └─ outbox / cola acotada → adaptador Bancs
                         │
                         ├─ rate limit + ventanas de lote
                         ├─ backpressure si crece la cola
                         └─ conciliación periódica saldos/estados
```

Principios:

1. **Capacidad del core:** techo de envíos/s acordado con operaciones de Bancs.
2. **Lotes solo si Bancs los admite;** si no, ventanas pequeñas con reintento.
3. **Backpressure:** si la cola de pendientes supera umbral, rechazar o diferir tráfico no esencial en el edge.
4. **Conciliación:** job que compare saldos/estados locales vs Bancs y emita diferencias.
5. **Circuit breaker:** si Bancs degrada, dejar de empujar y alertar; no martillar el core.

### 2.2. En este MVP

Solo se **simula** el envío (`BANCS_SIMULATED` en outbox). No hay integración real. La transformación de datos (ETL práctico del §3.2) está en `etl/transform.py` y alimenta `ai-db`, no a Bancs.

### 2.3. Evolución si Bancs es autoridad

Estados `RESERVED` → autorización Bancs → `POSTED`; timeout de reserva; conciliación. El MVP no lo implementa porque la fuente de verdad es local.

---

## 3. Inteligencia artificial — manejo del modelo (teórico) · §3.3

La integración asíncrona/no bloqueante es **práctica** (servicio independiente + outbox en el microservicio principal). Aquí el ciclo de vida en producción:

| Fase | Descripción |
| --- | --- |
| Alimentación | El ETL tipa movimientos (features: montos, categorías, ratios mes actual vs anterior) y los deja en un store de features (`ai-db` en el MVP). |
| Entrenamiento / calibración | Job periódico recalibra umbrales o reentrena con ventanas móviles; versiona el artefacto del modelo. |
| Despliegue | Contenedor de inferencia con CPU/memoria acotados, timeout de cliente y rollback de versión. |
| Inferencia | Solo vía worker/outbox; **nunca** en el hot path de la transferencia. |
| Data drift | Monitorear PSI (o KS) sobre features (`amountBucket`, comercio, moneda). Si PSI &gt; ~0.2, alertar y recalibrar/reentrenar. |
| Recursos | No escalar el modelo en el camino síncrono; cuotas y timeouts; degradación a reglas si el proveedor falla. |

En el MVP la inferencia usa Gemini (con fallback de reglas) sobre el ledger ETL; el ciclo ML completo queda como diseño.

---

## 4. Observabilidad — diseño (teórico) · §3.4

La instrumentación (logs, métricas, `correlation_id`) es **práctica** en código. El diseño teórico define **qué mirar y por qué**:

| Señal | Para qué sirve | Por qué es útil |
| --- | --- | --- |
| Logs de operaciones críticas (`transfer.create`, errores, llamadas IA, timeouts DB) | Saber **qué operación de negocio** falló o fue lenta | Acota el impacto al cliente y al caso de uso |
| Métricas de volumen, errores y latencia | Detectar pico, degradación y SLO (&lt; 2 s) | Permite alertar antes del reporte masivo de usuarios |
| `correlation_id` extremo a extremo | Rastrear una TX entre API, worker e IA | Une síntomas dispersos en un solo hilo |
| Contadores de deadlock / timeout de DB | Señalar contención en tablas calientes (`accounts`) | Distingue “app lenta” de “BD bloqueada” |
| Diagnóstico SQL (`pg_stat_activity` / `pg_locks`) | Identificar **sesión/consulta** bloqueante | Los logs de negocio no sustituyen el PID del lock |

Justificación: en un pico de quincena hace falta separar *síntoma de negocio* (transferencias incompletas) de *causa técnica* (lock, pool, IA lenta). Los datos anteriores cubren ambos planos sin saturar el path de dinero (la IA ya está fuera).

---

## 5. Incidente crítico simulado — acciones inmediatas (teórico) · §3.5

**Escenario:** pico de quincena; transferencias incompletas; latencia alta; timeouts a BD; posible deadlock en tablas principales.

El monitoreo práctico (logs/métricas/diagnóstico) está en el código. Acciones rápidas para estabilizar:

1. **Finalizar conexiones bloqueadas** (`pg_terminate_backend` sobre el `blocking_pid` del diagnóstico) o esperar `lock_timeout`.
2. **No subir el pool a ciegas** — más sesiones empeoran la contención.
3. **Rate limit / rechazo temporal** de transferencias no esenciales.
4. **Balancear carga** solo si hay réplicas sanas y el cuello no es un lock de fila; el LB no cura una TX larga.
5. **Confirmar que la IA no está en el request** (outbox) — un modelo lento no debe alargar el pico.
6. **Revisar timeouts de sesión/TX** (`lock_timeout`, `statement_timeout`, `idle_in_transaction_session_timeout`).

---

## 6. Gestión de incidentes TI — escalamiento y post mortem (teórico) · §3.6

### 6.1. Escalamiento

| Nivel | Acción |
| --- | --- |
| L1 | Confirmar degradación (métricas/logs); abrir diagnóstico de locks |
| L2 (DBA/platform) | Terminar backends bloqueantes; ajustar pool/timeouts; **no** ampliar pool sin criterio |
| L3 (desarrollo) | Revisar TX largas, orden de locks, idempotencia, ausencia de I/O externo en el `COMMIT` |
| Negocio | Comunicar degradación y ETA de estabilización |

### 6.2. Estructura del post mortem

1. Resumen ejecutivo  
2. Timeline (detección → diagnóstico → mitigación → recuperación)  
3. Impacto (usuarios, códigos de error, duración)  
4. Causa raíz (p. ej. contención en `accounts` por TX larga o locks cruzados)  
5. Qué funcionó (timeouts, reintentos de deadlock, outbox, diagnóstico)  
6. **Preventivo infraestructura:** PgBouncer, techos de conexión, `idle_in_transaction_session_timeout`, alertas de latencia/deadlock/timeout, rate limit en pico  
7. **Preventivo código:** TX cortas, locks ordenados por `id`, idempotencia, outbox (IA/Bancs fuera del request), sin trabajo externo dentro del `COMMIT`  
8. Seguimiento (dueño, fecha, criterio de cierre)

---

## 7. Seguridad (decisión de diseño)

Validación de entrada, SQL parametrizado, secretos fuera de Git, entorno local sin autenticación (cuentas de demostración). Sin dumps sensibles en logs. Justifica la dimensión de seguridad pedida al elegir el stack.

---

## 8. Escalabilidad hacia 10 000 TPS (evolución, no capacidad del prototipo)

El enunciado plantea picos del orden de 10 000 TPS. El MVP demuestra viabilidad y mide capacidad local; no afirma ese número. Evolución: más CPU/réplicas de API, pooler, cola/broker delante de Postgres, partición de drenado, consumo acotado hacia Bancs y medición dentro de la red interna. Evidencias numéricas del entorno de demo: `docs/resultados-medidos.md`.
