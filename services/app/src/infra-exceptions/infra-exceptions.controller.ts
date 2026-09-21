import { Body, Controller, Delete, Get, Post, Req, Res } from '@nestjs/common';
import { Response } from 'express';
import { randomUUID } from 'crypto';
import { CorrelatedRequest } from '../common/request-context.middleware';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInfraExceptionDto } from './dto';
import { InfraExceptionsService } from './infra-exceptions.service';

@Controller('api/v1/infra-exceptions')
export class InfraExceptionsController {
  constructor(
    private readonly infra: InfraExceptionsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('stats')
  async stats() {
    const [total, byCode] = await Promise.all([
      this.prisma.infraException.count(),
      this.prisma.infraException.groupBy({
        by: ['errorCode'],
        _count: { _all: true },
        orderBy: { _count: { errorCode: 'desc' } },
        take: 20,
      }),
    ]);
    return {
      total,
      byErrorCode: byCode.map((row) => ({ code: row.errorCode, count: row._count._all })),
    };
  }

  @Delete()
  async clear() {
    const result = await this.prisma.infraException.deleteMany();
    return { deleted: result.count };
  }

  @Post()
  async create(
    @Body() dto: CreateInfraExceptionDto,
    @Req() req: CorrelatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const correlationId = dto.correlationId || req.correlationId || randomUUID();
    await this.infra.record({
      correlationId,
      component: dto.component,
      errorCode: dto.errorCode,
      message: dto.message,
      operation: dto.operation,
      detail: {
        ...(dto.detail ?? {}),
        source: dto.component,
        httpPath: req.path,
      },
    });
    res.status(201);
    res.setHeader('x-correlation-id', correlationId);
    return { status: 'recorded', correlationId };
  }
}
