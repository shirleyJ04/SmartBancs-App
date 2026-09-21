import { Body, Controller, Delete, Get, Post, Req, Res } from '@nestjs/common';
import { Response } from 'express';
import { CorrelatedRequest } from '../common/request-context.middleware';
import { CreateRawTransactionBatchDto, CreateRawTransactionDto } from './dto';
import { RawTransactionsService } from './raw-transactions.service';

@Controller('api/v1/raw-transactions')
export class RawTransactionsController {
  constructor(private readonly raw: RawTransactionsService) {}

  @Get('stats')
  stats() {
    return this.raw.stats();
  }

  @Delete()
  async clear() {
    return this.raw.clearAll();
  }

  @Post()
  create(@Req() req: CorrelatedRequest, @Res({ passthrough: true }) res: Response) {
    const row = this.raw.createOne(
      req.body as CreateRawTransactionDto,
      req.correlationId,
    );
    res.status(202);
    res.setHeader('x-correlation-id', req.correlationId);
    return row;
  }

  @Post('batch')
  async createBatch(
    @Body() dto: CreateRawTransactionBatchDto,
    @Req() req: CorrelatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.raw.createBatch(dto.items, req.correlationId);
    res.setHeader('x-correlation-id', req.correlationId);
    return result;
  }
}
