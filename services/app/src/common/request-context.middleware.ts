import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { httpDuration } from './metrics';

export type CorrelatedRequest = Request & { correlationId: string };

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: CorrelatedRequest, res: Response, next: NextFunction) {
    const incoming = req.header('x-correlation-id');
    req.correlationId = incoming && incoming.trim().length > 0 ? incoming.trim() : randomUUID();
    res.setHeader('x-correlation-id', req.correlationId);
    const end = httpDuration.startTimer({ method: req.method, route: req.path });
    res.on('finish', () => {
      end({ status: String(res.statusCode) });
    });
    next();
  }
}
