import { HttpException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { InfraExceptionsService } from '../infra-exceptions/infra-exceptions.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRawTransactionDto } from './dto';

type EnqueueResult = {
  accepted: true;
  queued: true;
  id: string;
  uid: string;
  status: string;
  correlationId: string;
};

type PendingEnqueue = {
  id: string;
  correlationId: string;
  raw: Buffer;
};

@Injectable()
export class RawTransactionsService implements OnModuleDestroy {
  private readonly enqueueBatchSize = Math.max(
    1,
    Number(process.env.INGEST_ENQUEUE_BATCH_SIZE ?? 200),
  );
  private readonly enqueueFlushMs = Math.max(
    1,
    Number(process.env.INGEST_ENQUEUE_FLUSH_MS ?? 5),
  );
  private readonly enqueueMaxBuffered = Math.max(
    this.enqueueBatchSize,
    Number(process.env.INGEST_ENQUEUE_MAX_BUFFERED ?? 50_000),
  );
  private readonly enqueueFlushConcurrency = Math.max(
    1,
    Number(process.env.INGEST_ENQUEUE_FLUSH_CONCURRENCY ?? 4),
  );

  private buffer: PendingEnqueue[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private activeFlushes = 0;
  private flushWaiters: Array<() => void> = [];
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly infra: InfraExceptionsService,
  ) {}

  async onModuleDestroy() {
    this.stopped = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    while (this.buffer.length > 0 || this.activeFlushes > 0) {
      await this.scheduleFlush();
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  enqueueRaw(rawBody: Buffer, correlationId?: string): { correlationId: string; id: string } {
    if (this.stopped) {
      throw new HttpException(
        { code: 'SERVICE_UNAVAILABLE', message: 'API cerrando; reintenta' },
        503,
      );
    }
    if (!rawBody || rawBody.length < 8) {
      throw new HttpException(
        { code: 'VALIDATION_ERROR', message: 'Payload vacío' },
        400,
      );
    }
    if (this.buffer.length >= this.enqueueMaxBuffered) {
      throw new HttpException(
        {
          code: 'INGEST_BACKPRESSURE',
          correlationId: correlationId || randomUUID(),
          message: 'Cola de ingest saturada; reintenta',
        },
        503,
      );
    }

    const corr = correlationId || randomUUID();
    const queueId = randomUUID();
    this.buffer.push({ id: queueId, correlationId: corr, raw: rawBody });

    if (this.buffer.length >= this.enqueueBatchSize) {
      setImmediate(() => {
        void this.scheduleFlush();
      });
    } else {
      this.ensureFlushTimer();
    }

    return { correlationId: corr, id: queueId };
  }

  createOne(dto: CreateRawTransactionDto, correlationId?: string): EnqueueResult {
    const corr = correlationId || randomUUID();
    const raw = Buffer.from(JSON.stringify({ ...dto, correlationId: corr }));
    const enq = this.enqueueRaw(raw, corr);
    return {
      accepted: true,
      queued: true,
      id: enq.id,
      uid: dto.uid,
      status: dto.status,
      correlationId: corr,
    };
  }

  async createBatch(items: CreateRawTransactionDto[], correlationId?: string) {
    const batchCorr = correlationId || randomUUID();
    try {
      const result = await this.prisma.rawTransaction.createMany({
        data: items.map((item) => this.toCreateData(item)),
        skipDuplicates: true,
      });
      const accepted = result.count;
      const duplicates = Math.max(0, items.length - accepted);
      const businessRejected = items.filter((item) => item.status === 'REJECTED').length;
      return {
        received: items.length,
        accepted,
        businessRejected,
        duplicates,
        infraFailed: 0,
        batchCorrelationId: batchCorr,
        duplicateUids: [],
        infraFailures: [],
      };
    } catch (error) {
      const accepted: string[] = [];
      const duplicates: string[] = [];
      const businessRejected: string[] = [];
      const infraFailed: Array<{ uid: string; errorCode: string; correlationId: string }> = [];

      for (const item of items) {
        const itemCorr = randomUUID();
        try {
          await this.prisma.rawTransaction.create({ data: this.toCreateData(item) });
          accepted.push(item.uid);
          if (item.status === 'REJECTED') {
            businessRejected.push(item.uid);
          }
        } catch (itemError) {
          if (itemError instanceof Prisma.PrismaClientKnownRequestError && itemError.code === 'P2002') {
            duplicates.push(item.uid);
            continue;
          }
          const errorCode = this.infra.classify(itemError);
          await this.infra.recordFromError(itemError, {
            correlationId: itemCorr,
            component: 'api',
            operation: 'raw_transactions.batch',
            errorCode,
            detail: {
              uid: item.uid,
              account: item.account,
              status: item.status,
              typeCode: item.typeCode,
              amount: item.amount,
              batchCorrelationId: batchCorr,
            },
          });
          infraFailed.push({ uid: item.uid, errorCode, correlationId: itemCorr });
        }
      }

      return {
        received: items.length,
        accepted: accepted.length,
        businessRejected: businessRejected.length,
        duplicates: duplicates.length,
        infraFailed: infraFailed.length,
        batchCorrelationId: batchCorr,
        duplicateUids: duplicates.slice(0, 20),
        infraFailures: infraFailed.slice(0, 20),
      };
    }
  }

  async stats() {
    const [total, completed, rejected, infra, queued] = await Promise.all([
      this.prisma.rawTransaction.count(),
      this.prisma.rawTransaction.count({ where: { status: 'COMPLETED' } }),
      this.prisma.rawTransaction.count({ where: { status: 'REJECTED' } }),
      this.prisma.infraException.count(),
      this.prisma.ingestQueue.count({
        where: { status: { in: ['PENDING', 'CLAIMED'] } },
      }),
    ]);
    return {
      total,
      completed,
      rejected,
      infraExceptions: infra,
      queued,
      buffered: this.buffer.length,
    };
  }

  async clearAll() {
    while (this.buffer.length > 0 || this.activeFlushes > 0) {
      await this.scheduleFlush();
      await new Promise((r) => setTimeout(r, 5));
    }
    const [raw, queue] = await this.prisma.$transaction([
      this.prisma.rawTransaction.deleteMany(),
      this.prisma.ingestQueue.deleteMany(),
    ]);
    return { deleted: raw.count, queueCleared: queue.count };
  }

  private ensureFlushTimer() {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.scheduleFlush();
    }, this.enqueueFlushMs);
    this.flushTimer.unref?.();
  }

  private async acquireFlushSlot() {
    if (this.activeFlushes < this.enqueueFlushConcurrency) {
      this.activeFlushes += 1;
      return;
    }
    await new Promise<void>((resolve) => this.flushWaiters.push(resolve));
    this.activeFlushes += 1;
  }

  private releaseFlushSlot() {
    this.activeFlushes = Math.max(0, this.activeFlushes - 1);
    const next = this.flushWaiters.shift();
    if (next) {
      next();
    }
  }

  private async scheduleFlush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.buffer.length === 0) {
      return;
    }

    await this.acquireFlushSlot();
    const batch = this.buffer.splice(0, this.enqueueBatchSize);
    try {
      const rows: Array<{ id: string; status: string; payload: Prisma.InputJsonValue }> = [];
      for (const item of batch) {
        try {
          const parsed = JSON.parse(item.raw.toString('utf8')) as Record<string, unknown>;
          parsed.correlationId = parsed.correlationId || item.correlationId;
          rows.push({
            id: item.id,
            status: 'PENDING',
            payload: parsed as Prisma.InputJsonValue,
          });
        } catch {
          await this.infra.recordFromError(new Error('invalid_json_payload'), {
            correlationId: item.correlationId,
            component: 'api',
            operation: 'raw_transactions.enqueue_parse',
            detail: { queueId: item.id, bytes: item.raw.length },
          });
        }
      }
      if (rows.length > 0) {
        await this.prisma.ingestQueue.createMany({ data: rows });
      }
    } catch (error) {
      this.buffer.unshift(...batch);
      await this.infra.recordFromError(error, {
        correlationId: randomUUID(),
        component: 'api',
        operation: 'raw_transactions.enqueue_batch',
        detail: { batchSize: batch.length },
      });
      this.ensureFlushTimer();
    } finally {
      this.releaseFlushSlot();
      if (this.buffer.length >= this.enqueueBatchSize) {
        void this.scheduleFlush();
      } else if (this.buffer.length > 0) {
        this.ensureFlushTimer();
      }
    }
  }

  private toCreateData(dto: CreateRawTransactionDto): Prisma.RawTransactionCreateInput {
    const reason = dto.rejectReason?.trim() || null;
    return {
      id: randomUUID(),
      uid: dto.uid,
      accountNumber: dto.account.toUpperCase(),
      typeCode: dto.typeCode,
      typeName: dto.typeName,
      natureCode: dto.natureCode,
      productCode: dto.productCode,
      status: dto.status,
      amount: new Prisma.Decimal(dto.amount),
      currency: dto.currency,
      bookedOn: new Date(`${dto.date}T00:00:00.000Z`),
      counterpartName: dto.counterpartName,
      category: dto.category,
      rejectReason: reason || null,
    };
  }
}
