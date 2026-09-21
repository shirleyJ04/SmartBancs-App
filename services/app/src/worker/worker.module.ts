import { Module } from '@nestjs/common';
import { IngestProcessor } from './ingest.processor';
import { OutboxProcessor } from './outbox.processor';

@Module({
  providers: [OutboxProcessor, IngestProcessor],
})
export class WorkerModule {}
