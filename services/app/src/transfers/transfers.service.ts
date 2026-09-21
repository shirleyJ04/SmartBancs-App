import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { randomUUID } from 'crypto';
import { logger } from '../common/logger';
import { formatMoney, MoneyError, parseAmount, requestHash } from '../common/money';
import {
  dbDeadlocksTotal,
  dbTimeoutsTotal,
  transferErrorsTotal,
  transfersTotal,
} from '../common/metrics';
import {
  getPgCode,
  isLockOrStatementTimeout,
  isRecoverableConcurrencyError,
} from '../common/pg-error';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTransferDto } from './dto';

type LockedAccount = {
  id: string;
  account_number: string;
  balance: string;
  currency: string;
};

export type TransferResult = {
  id: string;
  correlationId: string;
  fromAccount: string;
  toAccount: string;
  amount: string;
  currency: string;
  status: 'COMPLETED';
  replayed: boolean;
  createdAt: string;
};

class TransferDomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'TransferDomainError';
  }
}

@Injectable()
export class TransfersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateTransferDto, correlationId: string): Promise<TransferResult> {
    const started = Date.now();
    try {
      const amount = parseAmount(dto.amount);
      const currency = dto.currency.trim().toUpperCase();
      const fromAccount = dto.fromAccount.trim();
      const toAccount = dto.toAccount.trim();
      const hash = requestHash({ ...dto, amount: formatMoney(amount), currency });

      if (fromAccount === toAccount) {
        throw new TransferDomainError('SAME_ACCOUNT', 'El origen y el destino deben ser distintos');
      }

      const result = await this.executeWithRetry({
        dto: { ...dto, fromAccount, toAccount, amount: formatMoney(amount), currency },
        amount,
        hash,
        correlationId,
      });

      transfersTotal.inc({ status: result.replayed ? 'replayed' : 'COMPLETED' });
      logger.info(
        {
          correlation_id: correlationId,
          operation: 'transfer.create',
          transfer_id: result.id,
          from_account: fromAccount,
          to_account: toAccount,
          duration_ms: Date.now() - started,
          replayed: result.replayed,
        },
        'Transferencia completada',
      );
      return result;
    } catch (error) {
      const mapped = await this.mapAndRecordFailure(dto, correlationId, error);
      transferErrorsTotal.inc({ code: mapped.code });
      logger.warn(
        {
          correlation_id: correlationId,
          operation: 'transfer.create',
          error_code: mapped.code,
          duration_ms: Date.now() - started,
        },
        mapped.message,
      );
      throw mapped.exception;
    }
  }

  private async executeWithRetry(input: {
    dto: CreateTransferDto;
    amount: Decimal;
    hash: string;
    correlationId: string;
  }): Promise<TransferResult> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.executeTransfer(input);
      } catch (error) {
        if (isRecoverableConcurrencyError(error) && attempt < maxAttempts) {
          dbDeadlocksTotal.inc();
          logger.warn(
            {
              correlation_id: input.correlationId,
              operation: 'transfer.retry',
              pg_code: getPgCode(error),
              attempt,
            },
            'Error recuperable de concurrencia; reintento de la transacción completa',
          );
          await sleep(40 * attempt);
          continue;
        }
        if (isLockOrStatementTimeout(error)) {
          dbTimeoutsTotal.inc();
        }
        throw error;
      }
    }
    throw new Error('No se pudo completar la transferencia tras reintentos');
  }

  private async executeTransfer(input: {
    dto: CreateTransferDto;
    amount: Decimal;
    hash: string;
    correlationId: string;
  }): Promise<TransferResult> {
    const lockTimeout = sanitizeTimeout(process.env.LOCK_TIMEOUT, '2s');
    const statementTimeout = sanitizeTimeout(process.env.STATEMENT_TIMEOUT, '5s');

    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${lockTimeout}'`);
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${statementTimeout}'`);

        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtext(${input.dto.idempotencyKey}))
        `;

        const existing = await tx.$queryRaw<
          Array<{
            id: string;
            request_hash: string;
            status: string;
            from_account: string;
            to_account: string;
            amount: string;
            currency: string;
            created_at: Date;
          }>
        >`
          SELECT t.id::text,
                 t.request_hash,
                 t.status,
                 fa.account_number AS from_account,
                 ta.account_number AS to_account,
                 t.amount::text,
                 t.currency,
                 t.created_at
          FROM transfers t
          JOIN accounts fa ON fa.id = t.from_account_id
          JOIN accounts ta ON ta.id = t.to_account_id
          WHERE t.idempotency_key = ${input.dto.idempotencyKey}
        `;

        if (existing[0]) {
          if (existing[0].request_hash !== input.hash) {
            throw new TransferDomainError(
              'IDEMPOTENCY_CONFLICT',
              'La clave de idempotencia ya fue usada con otro contenido',
              409,
            );
          }
          return {
            id: existing[0].id,
            correlationId: input.correlationId,
            fromAccount: existing[0].from_account,
            toAccount: existing[0].to_account,
            amount: formatMoney(existing[0].amount),
            currency: existing[0].currency.trim(),
            status: 'COMPLETED',
            replayed: true,
            createdAt: existing[0].created_at.toISOString(),
          };
        }

        const accounts = await tx.$queryRaw<LockedAccount[]>`
          SELECT id::text, account_number, balance::text, currency
          FROM accounts
          WHERE account_number = ${input.dto.fromAccount}
             OR account_number = ${input.dto.toAccount}
          ORDER BY id
          FOR UPDATE
        `;

        if (accounts.length !== 2) {
          throw new TransferDomainError('ACCOUNT_NOT_FOUND', 'Una o ambas cuentas no existen');
        }

        const source = accounts.find((account) => account.account_number === input.dto.fromAccount);
        const destination = accounts.find((account) => account.account_number === input.dto.toAccount);
        if (!source || !destination) {
          throw new TransferDomainError('ACCOUNT_NOT_FOUND', 'Una o ambas cuentas no existen');
        }

        if (source.currency.trim() !== input.dto.currency || destination.currency.trim() !== input.dto.currency) {
          throw new TransferDomainError('CURRENCY_MISMATCH', 'La moneda no es compatible con las cuentas');
        }

        const debit = await tx.$queryRaw<Array<{ balance: string }>>`
          UPDATE accounts
          SET balance = balance - ${input.amount.toFixed(2)}::numeric,
              updated_at = now()
          WHERE id = ${source.id}::uuid
            AND balance >= ${input.amount.toFixed(2)}::numeric
          RETURNING balance::text
        `;

        if (!debit[0]) {
          throw new TransferDomainError(
            'INSUFFICIENT_FUNDS',
            'Saldo insuficiente para completar la transferencia',
            422,
          );
        }

        await tx.$executeRaw`
          UPDATE accounts
          SET balance = balance + ${input.amount.toFixed(2)}::numeric,
              updated_at = now()
          WHERE id = ${destination.id}::uuid
        `;

        const transferId = randomUUID();
        const now = new Date();
        await tx.$executeRaw`
          INSERT INTO transfers (
            id, correlation_id, idempotency_key, request_hash,
            from_account_id, to_account_id, amount, currency, status, created_at
          ) VALUES (
            ${transferId}::uuid,
            ${input.correlationId}::uuid,
            ${input.dto.idempotencyKey},
            ${input.hash},
            ${source.id}::uuid,
            ${destination.id}::uuid,
            ${input.amount.toFixed(2)}::numeric,
            ${input.dto.currency},
            'COMPLETED',
            ${now}
          )
        `;

        const payload = JSON.stringify({
          transferId,
          correlationId: input.correlationId,
          accountId: source.id,
          accountNumber: source.account_number,
          amount: input.amount.toFixed(2),
          currency: input.dto.currency,
          balanceAfter: debit[0].balance,
        });

        await tx.$executeRaw`
          INSERT INTO outbox_events (
            id, event_type, payload, status, attempts, next_attempt_at, transfer_id, created_at
          ) VALUES (
            ${randomUUID()}::uuid, 'AI_RECOMMEND', ${payload}::jsonb, 'PENDING', 0, now(), ${transferId}::uuid, now()
          )
        `;

        await tx.$executeRaw`
          INSERT INTO outbox_events (
            id, event_type, payload, status, attempts, next_attempt_at, transfer_id, created_at
          ) VALUES (
            ${randomUUID()}::uuid, 'BANCS_SIMULATED', ${payload}::jsonb, 'PENDING', 0, now(), ${transferId}::uuid, now()
          )
        `;

        return {
          id: transferId,
          correlationId: input.correlationId,
          fromAccount: source.account_number,
          toAccount: destination.account_number,
          amount: input.amount.toFixed(2),
          currency: input.dto.currency,
          status: 'COMPLETED' as const,
          replayed: false,
          createdAt: now.toISOString(),
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: 10_000,
        maxWait: 5_000,
      },
    );
  }

  private async mapAndRecordFailure(
    dto: CreateTransferDto,
    correlationId: string,
    error: unknown,
  ): Promise<{ code: string; message: string; exception: HttpException }> {
    if (error instanceof MoneyError || error instanceof TransferDomainError) {
      await this.recordFailure(dto, correlationId, error.code, error.message);
      const exception =
        error instanceof TransferDomainError && error.status === 409
          ? new ConflictException({ code: error.code, message: error.message, correlationId })
          : error instanceof TransferDomainError && error.status === 422
            ? new UnprocessableEntityException({ code: error.code, message: error.message, correlationId })
            : new BadRequestException({ code: error.code, message: error.message, correlationId });
      return { code: error.code, message: error.message, exception };
    }

    if (isLockOrStatementTimeout(error)) {
      const message = 'Timeout de bloqueo o de sentencia en la base de datos';
      await this.recordInfraException(dto, correlationId, 'DB_TIMEOUT', message, 'db');
      return {
        code: 'DB_TIMEOUT',
        message,
        exception: new HttpException({ code: 'DB_TIMEOUT', message, correlationId }, 503),
      };
    }

    if (isRecoverableConcurrencyError(error)) {
      const message = 'Contención de base de datos no resuelta tras reintentos';
      await this.recordInfraException(dto, correlationId, 'DB_DEADLOCK', message, 'db');
      return {
        code: 'DB_DEADLOCK',
        message,
        exception: new HttpException({ code: 'DB_DEADLOCK', message, correlationId }, 503),
      };
    }

    const message = error instanceof Error ? error.message : 'Error interno';
    await this.recordInfraException(dto, correlationId, 'INTERNAL_ERROR', message, 'api');
    return {
      code: 'INTERNAL_ERROR',
      message: 'No se pudo completar la transferencia',
      exception: new HttpException({ code: 'INTERNAL_ERROR', message: 'No se pudo completar la transferencia', correlationId }, 500),
    };
  }

  private async recordFailure(
    dto: CreateTransferDto,
    correlationId: string,
    reasonCode: string,
    reasonMessage: string,
  ) {
    try {
      await this.prisma.transferFailure.create({
        data: {
          id: randomUUID(),
          correlationId,
          idempotencyKey: dto.idempotencyKey,
          fromAccount: dto.fromAccount,
          toAccount: dto.toAccount,
          amount: dto.amount,
          currency: dto.currency,
          reasonCode,
          reasonMessage,
        },
      });
    } catch (error) {
      logger.error({ correlation_id: correlationId, err: error }, 'No se pudo persistir transfer_failures');
    }
  }

  private async recordInfraException(
    dto: CreateTransferDto,
    correlationId: string,
    errorCode: string,
    message: string,
    component: string,
  ) {
    try {
      await this.prisma.infraException.create({
        data: {
          id: randomUUID(),
          correlationId,
          component,
          errorCode,
          message,
          operation: 'transfers.create',
          detail: {
            fromAccount: dto.fromAccount,
            toAccount: dto.toAccount,
            amount: dto.amount,
            currency: dto.currency,
            idempotencyKey: dto.idempotencyKey,
          },
        },
      });
    } catch (error) {
      logger.error({ correlation_id: correlationId, err: error }, 'No se pudo persistir infra_exceptions');
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeTimeout(value: string | undefined, fallback: string): string {
  return value && /^\d+(ms|s)$/.test(value) ? value : fallback;
}
