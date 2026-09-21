import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { AccountsModule } from './accounts/accounts.module';
import { RequestContextMiddleware } from './common/request-context.middleware';
import { HealthController } from './health/health.controller';
import { MetricsController } from './metrics/metrics.controller';
import { PrismaModule } from './prisma/prisma.module';
import { InfraExceptionsModule } from './infra-exceptions/infra-exceptions.module';
import { RawTransactionsModule } from './raw-transactions/raw-transactions.module';
import { TransfersModule } from './transfers/transfers.module';
import { WorkerModule } from './worker/worker.module';

const staticImports =
  process.env.NODE_ENV === 'test'
    ? []
    : [
        ServeStaticModule.forRoot({
          rootPath: join(process.cwd(), 'public'),
          exclude: ['/api/(.*)', '/health', '/metrics'],
        }),
      ];

@Module({
  imports: [
    PrismaModule,
    TransfersModule,
    AccountsModule,
    RawTransactionsModule,
    InfraExceptionsModule,
    WorkerModule,
    ...staticImports,
  ],
  controllers: [HealthController, MetricsController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
