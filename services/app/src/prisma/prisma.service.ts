import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

function withPoolLimit(url: string | undefined, max: number): string | undefined {
  if (!url) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', String(max));
  if (!parsed.searchParams.has('pool_timeout')) {
    parsed.searchParams.set('pool_timeout', '10');
  }
  return parsed.toString();
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const poolMax = Number(process.env.DB_POOL_MAX ?? 20);
    super({
      datasources: {
        db: {
          url: withPoolLimit(process.env.DATABASE_URL, poolMax),
        },
      },
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
