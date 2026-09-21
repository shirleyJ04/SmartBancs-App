import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { logger } from '../common/logger';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRawTransactionDto } from '../raw-transactions/dto';

type ClaimedIngest = {
  id: string;
  payload: Prisma.JsonValue;
  attempts: number;
};

type IngestPayload = CreateRawTransactionDto & { correlationId?: string };

@Injectable()
export class IngestProcessor implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.APP_ROLE !== 'worker') {
      return;
    }
    const pollMs = Number(process.env.INGEST_POLL_MS ?? 100);
    this.timer = setInterval(() => {
      void this.tick();
    }, pollMs);
    logger.info({ operation: 'ingest.start', poll_ms: pollMs }, 'Worker de ingest iniciado');
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async tick() {
    if (this.stopped || this.running) {
      return;
    }
    this.running = true;
    try {
      const items = await this.claimBatch();
      for (const item of items) {
        await this.process(item);
      }
    } catch (error) {
      logger.error({ err: error, operation: 'ingest.tick' }, 'Fallo en el ciclo de ingest');
    } finally {
      this.running = false;
    }
  }

  async claimBatch(): Promise<ClaimedIngest[]> {
    const batchSize = Number(process.env.INGEST_BATCH_SIZE ?? 50);
    const leaseSeconds = Number(process.env.INGEST_LEASE_SECONDS ?? 30);

    return this.prisma.$transaction(async (tx) => {
      return tx.$queryRaw<ClaimedIngest[]>`
        WITH picked AS (
          SELECT id
          FROM ingest_queue
          WHERE (status = 'PENDING' AND next_attempt_at <= now())
             OR (status = 'CLAIMED' AND claim_expires_at < now())
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT ${batchSize}
        )
        UPDATE ingest_queue q
        SET status = 'CLAIMED',
            claimed_at = now(),
            claim_expires_at = now() + (${leaseSeconds} * interval '1 second'),
            attempts = q.attempts + 1
        FROM picked
        WHERE q.id = picked.id
        RETURNING q.id::text, q.payload, q.attempts
      `;
    });
  }

  private async process(item: ClaimedIngest) {
    const maxAttempts = Number(process.env.INGEST_MAX_ATTEMPTS ?? 5);
    const payload = item.payload as unknown as IngestPayload;
    try {
      await this.persistRaw(payload);
      await this.markDone(item.id);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        await this.markDone(item.id);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        { operation: 'ingest.process', ingest_id: item.id, uid: payload.uid, err: message },
        'Fallo al drenar ingest_queue → raw_transactions',
      );
      await this.recordInfraException({
        correlationId: payload.correlationId,
        message,
        detail: {
          ingestId: item.id,
          uid: payload.uid,
          attempts: item.attempts,
        },
      });
      if (item.attempts >= maxAttempts) {
        await this.markDead(item.id, message);
      } else {
        await this.scheduleRetry(item.id, message, item.attempts);
      }
    }
  }

  private async persistRaw(payload: IngestPayload) {
    const reason = payload.rejectReason?.trim() || null;
    await this.prisma.rawTransaction.create({
      data: {
        id: randomUUID(),
        uid: payload.uid,
        accountNumber: payload.account.toUpperCase(),
        typeCode: payload.typeCode,
        typeName: payload.typeName,
        natureCode: payload.natureCode,
        productCode: payload.productCode,
        status: payload.status,
        amount: new Prisma.Decimal(payload.amount),
        currency: payload.currency,
        bookedOn: new Date(`${payload.date}T00:00:00.000Z`),
        counterpartName: payload.counterpartName,
        category: payload.category,
        rejectReason: reason || null,
      },
    });
  }

  private markDone(id: string) {
    return this.prisma.$executeRaw`
      UPDATE ingest_queue
      SET status = 'DONE', processed_at = now(), last_error = NULL
      WHERE id = ${id}::uuid
    `;
  }

  private markDead(id: string, lastError: string) {
    return this.prisma.$executeRaw`
      UPDATE ingest_queue
      SET status = 'DEAD', last_error = ${lastError}, processed_at = now()
      WHERE id = ${id}::uuid
    `;
  }

  private scheduleRetry(id: string, lastError: string, attempts: number) {
    const delaySeconds = Math.min(2 ** attempts, 30);
    return this.prisma.$executeRaw`
      UPDATE ingest_queue
      SET status = 'PENDING',
          last_error = ${lastError},
          next_attempt_at = now() + (${delaySeconds} * interval '1 second'),
          claim_expires_at = NULL
      WHERE id = ${id}::uuid
    `;
  }

  private async recordInfraException(input: {
    correlationId?: string;
    message: string;
    detail: Record<string, unknown>;
  }) {
    try {
      await this.prisma.infraException.create({
        data: {
          id: randomUUID(),
          correlationId: input.correlationId,
          component: 'worker',
          errorCode: 'INGEST_PROCESS_ERROR',
          message: input.message.slice(0, 2000),
          operation: 'ingest.drain',
          detail: input.detail as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      logger.error({ err: error, operation: 'infra_exceptions.create' }, 'No se pudo persistir infra_exceptions');
    }
  }
}
