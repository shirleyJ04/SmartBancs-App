# Declaración de uso de inteligencia artificial

Se utilizó Cursor (agente de desarrollo asistido por IA) para:

- Generar el esqueleto del proyecto y su estructura (NestJS, Prisma, Docker Compose, carpetas y módulos base).
- Apoyar en la corrección de bugs durante el desarrollo.

Además se usó la **API de Google Gemini** en el servicio `services/ai` para generar **recomendaciones de salud financiera** a partir del ledger y los prompts del ETL (`ai-db`): comparar gasto entre periodos, señalar picos por categoría y, si el historial es insuficiente, indicar que hacen falta más datos (`NEED_MORE_DATA`). La transferencia no espera a Gemini; el worker la invoca de forma asíncrona tras el `COMMIT`. Si la API no responde, el servicio cae a reglas locales.
