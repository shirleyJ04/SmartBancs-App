import { Module } from '@nestjs/common';
import { InfraExceptionsController } from './infra-exceptions.controller';
import { InfraExceptionsService } from './infra-exceptions.service';

@Module({
  controllers: [InfraExceptionsController],
  providers: [InfraExceptionsService],
  exports: [InfraExceptionsService],
})
export class InfraExceptionsModule {}
