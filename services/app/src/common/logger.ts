import pino, { Logger } from 'pino';

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: process.env.APP_ROLE === 'worker' ? 'smartbancs-worker' : 'smartbancs-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
});
