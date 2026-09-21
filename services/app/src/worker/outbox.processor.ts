import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { logger } from '../common/logger';
import { aiCallDuration, aiCallsTotal, outboxEvents } from '../common/metrics';
import { PrismaService } from '../prisma/prisma.service';

type ClaimedEvent = {
  id: string;
  event_type: string;
  payload: Prisma.JsonValue;
  attempts: number;
  transfer_id: string | null;
};

@Injectable()
export class OutboxProcessor implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.APP_ROLE !== 'worker') {
      return;
    }
    const pollMs = Number(process.env.OUTBOX_POLL_MS ?? 500);
    this.timer = setInterval(() => {
      void this.tick();
    }, pollMs);
    logger.info({ operation: 'outbox.start', poll_ms: pollMs }, 'Worker de outbox iniciado');
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
      const events = await this.claimBatch();
      for (const event of events) {
        await this.process(event);
      }
    } catch (error) {
      logger.error({ err: error, operation: 'outbox.tick' }, 'Fallo en el ciclo de outbox');
    } finally {
      this.running = false;
    }
  }

  async claimBatch(): Promise<ClaimedEvent[]> {
    const batchSize = Number(process.env.OUTBOX_BATCH_SIZE ?? 10);
    const leaseSeconds = Number(process.env.OUTBOX_LEASE_SECONDS ?? 30);

    return this.prisma.$transaction(async (tx) => {
      return tx.$queryRaw<ClaimedEvent[]>`
        WITH picked AS (
          SELECT id
          FROM outbox_events
          WHERE (status = 'PENDING' AND next_attempt_at <= now())
             OR (status = 'CLAIMED' AND claim_expires_at < now())
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT ${batchSize}
        )
        UPDATE outbox_events o
        SET status = 'CLAIMED',
            claimed_at = now(),
            claim_expires_at = now() + (${leaseSeconds} * interval '1 second'),
            attempts = o.attempts + 1
        FROM picked
        WHERE o.id = picked.id
        RETURNING o.id::text, o.event_type, o.payload, o.attempts, o.transfer_id::text
      `;
    });
  }

  private async process(event: ClaimedEvent) {
    const maxAttempts = Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 5);
    try {
      if (event.event_type === 'AI_RECOMMEND') {
        await this.handleAi(event);
      } else if (event.event_type === 'BANCS_SIMULATED') {
        await this.handleBancsSimulated(event);
      } else {
        throw new Error(`Tipo de evento desconocido: ${event.event_type}`);
      }
      await this.markDone(event.id);
      outboxEvents.inc({ status: 'DONE' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        { operation: 'outbox.process', outbox_event_id: event.id, event_type: event.event_type, err: message },
        'Fallo al procesar evento de outbox',
      );
      const payload = event.payload as { correlationId?: string };
      const errorCode = classifyInfraError(message);
      await this.recordInfraException({
        correlationId: payload.correlationId,
        component: event.event_type === 'AI_RECOMMEND' ? 'ai' : 'worker',
        errorCode,
        message,
        operation: `outbox.${event.event_type}`,
        detail: {
          outboxEventId: event.id,
          eventType: event.event_type,
          attempts: event.attempts,
          transferId: event.transfer_id,
        },
      });
      if (event.attempts >= maxAttempts) {
        await this.markDead(event.id, message);
        outboxEvents.inc({ status: 'DEAD' });
      } else {
        await this.scheduleRetry(event.id, message, event.attempts);
        outboxEvents.inc({ status: 'RETRY' });
      }
    }
  }

  private async handleAi(event: ClaimedEvent) {
    const payload = event.payload as {
      accountId: string;
      accountNumber: string;
      amount: string;
      currency: string;
      balanceAfter: string;
      correlationId: string;
      transferId: string;
    };
    const started = Date.now();
    const url = `${process.env.AI_SERVICE_URL ?? 'http://localhost:3001'}/v1/recommend`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': payload.correlationId,
      },
      body: JSON.stringify({
        accountId: payload.accountId,
        accountNumber: payload.accountNumber,
        balance: payload.balanceAfter,
        currency: payload.currency,
        transferAmount: payload.amount,
        correlationId: payload.correlationId,
      }),
    });
    aiCallDuration.observe((Date.now() - started) / 1000);
    if (!response.ok) {
      aiCallsTotal.inc({ result: 'error' });
      throw new Error(`IA respondió ${response.status}`);
    }
    const body = (await response.json()) as {
      message: string;
      category: string;
      confidence: number | string;
    };
    aiCallsTotal.inc({ result: 'ok' });

    await this.prisma.$executeRaw`
      INSERT INTO recommendations (id, account_id, outbox_event_id, message, category, confidence, created_at)
      VALUES (
        ${randomUUID()}::uuid,
        ${payload.accountId}::uuid,
        ${event.id}::uuid,
        ${body.message},
        ${body.category},
        ${String(body.confidence)}::numeric,
        now()
      )
      ON CONFLICT (outbox_event_id) DO NOTHING
    `;
  }

  private async handleBancsSimulated(event: ClaimedEvent) {
    const payload = event.payload as { transferId?: string; correlationId?: string };
    logger.info(
      {
        operation: 'bancs.simulated',
        outbox_event_id: event.id,
        transfer_id: payload.transferId,
        correlation_id: payload.correlationId,
      },
      'Sincronización Bancs simulada; no se envió nada a un core real',
    );
  }

  private markDone(id: string) {
    return this.prisma.$executeRaw`
      UPDATE outbox_events
      SET status = 'DONE', processed_at = now(), last_error = NULL
      WHERE id = ${id}::uuid
    `;
  }

  private markDead(id: string, lastError: string) {
    return this.prisma.$executeRaw`
      UPDATE outbox_events
      SET status = 'DEAD', last_error = ${lastError}, processed_at = now()
      WHERE id = ${id}::uuid
    `;
  }

  private scheduleRetry(id: string, lastError: string, attempts: number) {
    const delaySeconds = Math.min(2 ** attempts, 30);
    return this.prisma.$executeRaw`
      UPDATE outbox_events
      SET status = 'PENDING',
          last_error = ${lastError},
          next_attempt_at = now() + (${delaySeconds} * interval '1 second'),
          claim_expires_at = NULL
      WHERE id = ${id}::uuid
    `;
  }

  private async recordInfraException(input: {
    correlationId?: string;
    component: string;
    errorCode: string;
    message: string;
    operation: string;
    detail: Record<string, unknown>;
  }) {
    try {
      await this.prisma.infraException.create({
        data: {
          id: randomUUID(),
          correlationId: input.correlationId,
          component: input.component,
          errorCode: input.errorCode,
          message: input.message.slice(0, 2000),
          operation: input.operation,
          detail: input.detail as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      logger.error({ err: error, operation: 'infra_exceptions.create' }, 'No se pudo persistir infra_exceptions');
    }
  }
}

function classifyInfraError(message: string): string {
  if (/timeout|aborted|AbortError/i.test(message)) return 'AI_TIMEOUT';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(message)) return 'CONNECTION_ERROR';
  if (/503|502|504|unavailable/i.test(message)) return 'AI_UNAVAILABLE';
  return 'OUTBOX_PROCESS_ERROR';
}
