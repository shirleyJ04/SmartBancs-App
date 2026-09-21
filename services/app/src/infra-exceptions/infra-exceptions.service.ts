import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { isLockOrStatementTimeout, isRecoverableConcurrencyError } from '../common/pg-error';
import { PrismaService } from '../prisma/prisma.service';
import { logger } from '../common/logger';

export type RecordInfraInput = {
  correlationId?: string | null;
  component: string;
  errorCode: string;
  message: string;
  operation?: string;
  detail?: Record<string, unknown>;
};

@Injectable()
export class InfraExceptionsService {
  constructor(private readonly prisma: PrismaService) {}

  classify(error: unknown): string {
    if (isLockOrStatementTimeout(error)) return 'DB_TIMEOUT';
    if (isRecoverableConcurrencyError(error)) return 'DB_DEADLOCK';
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout|aborted|ETIMEDOUT/i.test(message)) return 'TIMEOUT';
    if (/ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(message)) return 'CONNECTION_ERROR';
    return 'INTERNAL_ERROR';
  }

  async record(input: RecordInfraInput) {
    try {
      await this.prisma.infraException.create({
        data: {
          id: randomUUID(),
          correlationId: input.correlationId ?? null,
          component: input.component,
          errorCode: input.errorCode,
          message: input.message.slice(0, 2000),
          operation: input.operation ?? null,
          detail: input.detail ? (input.detail as Prisma.InputJsonValue) : undefined,
        },
      });
    } catch (error) {
      logger.error({ err: error, operation: 'infra_exceptions.create' }, 'No se pudo persistir infra_exceptions');
    }
  }

  async recordFromError(
    error: unknown,
    meta: {
      correlationId?: string | null;
      component: string;
      operation: string;
      detail?: Record<string, unknown>;
      errorCode?: string;
    },
  ) {
    const message = error instanceof Error ? error.message : String(error);
    await this.record({
      correlationId: meta.correlationId,
      component: meta.component,
      errorCode: meta.errorCode ?? this.classify(error),
      message,
      operation: meta.operation,
      detail: meta.detail,
    });
  }
}
