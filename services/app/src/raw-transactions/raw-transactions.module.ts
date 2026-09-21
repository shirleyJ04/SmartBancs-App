import { Module } from '@nestjs/common';
import { InfraExceptionsModule } from '../infra-exceptions/infra-exceptions.module';
import { RawTransactionsController } from './raw-transactions.controller';
import { RawTransactionsService } from './raw-transactions.service';

@Module({
  imports: [InfraExceptionsModule],
  controllers: [RawTransactionsController],
  providers: [RawTransactionsService],
  exports: [RawTransactionsService],
})
export class RawTransactionsModule {}
