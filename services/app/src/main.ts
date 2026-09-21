import { HttpException, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { json, raw, Request, Response, NextFunction } from 'express';
import cluster from 'node:cluster';
import { AppModule } from './app.module';
import { logger } from './common/logger';
import { RawTransactionsService } from './raw-transactions/raw-transactions.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: false });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'POST' && req.path === '/api/v1/raw-transactions') {
      return raw({ type: '*/*', limit: '64kb' })(req, res, next);
    }
    return next();
  });
  app.use(json({ limit: '2mb' }));

  const rawSvc = app.get(RawTransactionsService);
  const ACCEPTED_BODY = Buffer.from('{"accepted":true,"queued":true}');
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST' || req.path !== '/api/v1/raw-transactions') {
      return next();
    }
    const incoming = req.header('x-correlation-id');
    const corr =
      incoming && incoming.trim().length > 0 ? incoming.trim() : randomUUID();
    try {
      const bodyBuf = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));
      rawSvc.enqueueRaw(bodyBuf, corr);
      res.statusCode = 202;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('content-length', ACCEPTED_BODY.length);
      res.setHeader('x-correlation-id', corr);
      return res.end(ACCEPTED_BODY);
    } catch (error) {
      if (error instanceof HttpException) {
        const status = error.getStatus();
        const body = error.getResponse();
        res.setHeader('x-correlation-id', corr);
        return res.status(status).json(body);
      }
      logger.error({ err: error, correlation_id: corr }, 'Fast ingest fallo');
      return res.status(500).json({
        code: 'INTERNAL_ERROR',
        correlationId: corr,
        message: 'No se pudo encolar la transacción cruda',
      });
    }
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  logger.info(
    {
      role: process.env.APP_ROLE ?? 'api',
      port,
      pid: process.pid,
      clusterWorker: cluster.isWorker,
    },
    'SmartBancs iniciado',
  );
}

function start() {
  const role = process.env.APP_ROLE ?? 'api';
  const clusterOn = role === 'api' && process.env.API_CLUSTER === '1';
  const workers = Math.max(
    1,
    Number(process.env.API_WORKERS ?? 1),
  );

  if (clusterOn && cluster.isPrimary) {
    logger.info({ workers, role }, 'API cluster primary arrancando workers');
    for (let i = 0; i < workers; i += 1) {
      cluster.fork();
    }
    cluster.on('exit', (worker, code, signal) => {
      logger.warn(
        { pid: worker.process.pid, code, signal },
        'API worker salió; respawn',
      );
      cluster.fork();
    });
    return;
  }

  bootstrap().catch((error) => {
    logger.error({ err: error }, 'Fallo al iniciar SmartBancs');
    process.exit(1);
  });
}

start();
