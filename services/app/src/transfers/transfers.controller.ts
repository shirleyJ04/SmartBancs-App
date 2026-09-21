import { Body, Controller, Headers, Post, Req, Res } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { CreateTransferDto } from './dto';
import { TransfersService } from './transfers.service';

@Controller('api/v1/transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Post()
  async create(
    @Body() dto: CreateTransferDto,
    @Headers('idempotency-key') headerKey: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const payload = {
      ...dto,
      idempotencyKey: headerKey?.trim() || dto.idempotencyKey,
    };
    const correlationId =
      (request as Request & { correlationId?: string }).correlationId ??
      request.header('x-correlation-id') ??
      randomUUID();
    const result = await this.transfers.create(payload, correlationId);
    response.status(result.replayed ? 200 : 201);
    return result;
  }
}
