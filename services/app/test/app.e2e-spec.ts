import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import request from 'supertest';
import http from 'http';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TransfersService } from '../src/transfers/transfers.service';
import { OutboxProcessor } from '../src/worker/outbox.processor';
import { formatMoney } from '../src/common/money';

process.env.DATABASE_URL ??= 'postgresql://smartbancs:smartbancs@localhost:5432/smartbancs';
process.env.APP_ROLE = 'api';
process.env.NODE_ENV = 'test';

describe('SmartBancs acceptance', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let transfers: TransfersService;
  let outbox: OutboxProcessor;
  let aiServer: http.Server;
  let aiCalls = 0;
  let aiShouldFail = false;

  beforeAll(async () => {
    aiServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/recommend') {
        aiCalls += 1;
        if (aiShouldFail) {
          res.writeHead(503);
          res.end('down');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          message: 'Recomendación de prueba',
          category: 'SPENDING_INSIGHT',
          confidence: '0.5000',
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => aiServer.listen(0, resolve));
    const address = aiServer.address();
    if (address && typeof address === 'object') {
      process.env.AI_SERVICE_URL = `http://127.0.0.1:${address.port}`;
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    transfers = app.get(TransfersService);
    outbox = app.get(OutboxProcessor);
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) => aiServer.close((err) => (err ? reject(err) : resolve())));
  });

  beforeEach(async () => {
    aiCalls = 0;
    aiShouldFail = false;
    await prisma.recommendation.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.transfer.deleteMany();
    await prisma.transferFailure.deleteMany();
    await prisma.infraException.deleteMany();
    await prisma.rawTransaction.deleteMany();
    await prisma.account.update({ where: { accountNumber: 'ACC-001' }, data: { balance: '10000.00' } });
    await prisma.account.update({ where: { accountNumber: 'ACC-002' }, data: { balance: '5000.00' } });
    await prisma.account.update({ where: { accountNumber: 'ACC-003' }, data: { balance: '2500.00' } });
    await prisma.account.update({ where: { accountNumber: 'ACC-004' }, data: { balance: '100.00' } });
  });

  async function balances() {
    const rows = await prisma.account.findMany({ orderBy: { accountNumber: 'asc' } });
    return Object.fromEntries(rows.map((row) => [row.accountNumber, formatMoney(row.balance.toString())]));
  }

  it('1. transfiere con débito/crédito exactos y conserva la suma', async () => {
    const before = await balances();
    const result = await transfers.create(
      {
        fromAccount: 'ACC-001',
        toAccount: 'ACC-002',
        amount: '125.50',
        currency: 'USD',
        idempotencyKey: 'acc-1-ok',
      },
      randomUUID(),
    );
    expect(result.status).toBe('COMPLETED');
    const after = await balances();
    expect(after['ACC-001']).toBe('9874.50');
    expect(after['ACC-002']).toBe('5125.50');
    const sumBefore = Number(before['ACC-001']) + Number(before['ACC-002']);
    const sumAfter = Number(after['ACC-001']) + Number(after['ACC-002']);
    expect(sumAfter).toBe(sumBefore);
  });

  it('2. saldo insuficiente no cambia saldos ni crea transferencia', async () => {
    await expect(
      transfers.create(
        {
          fromAccount: 'ACC-004',
          toAccount: 'ACC-001',
          amount: '500.00',
          currency: 'USD',
          idempotencyKey: 'acc-2-nsf',
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 422 });
    const after = await balances();
    expect(after['ACC-004']).toBe('100.00');
    expect(after['ACC-001']).toBe('10000.00');
    expect(await prisma.transfer.count()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);
    expect(await prisma.transferFailure.count()).toBeGreaterThan(0);
  });

  it('3. la misma clave concurrente produce un solo débito', async () => {
    const key = 'acc-3-same-key';
    const payload = {
      fromAccount: 'ACC-001',
      toAccount: 'ACC-002',
      amount: '10.00',
      currency: 'USD',
      idempotencyKey: key,
    };
    const [a, b] = await Promise.all([
      transfers.create(payload, randomUUID()),
      transfers.create(payload, randomUUID()),
    ]);
    expect(a.id).toBe(b.id);
    const after = await balances();
    expect(after['ACC-001']).toBe('9990.00');
    expect(await prisma.transfer.count()).toBe(1);
  });

  it('4. la misma clave con otro monto se rechaza', async () => {
    await transfers.create(
      {
        fromAccount: 'ACC-001',
        toAccount: 'ACC-002',
        amount: '10.00',
        currency: 'USD',
        idempotencyKey: 'acc-4-conflict',
      },
      randomUUID(),
    );
    await expect(
      transfers.create(
        {
          fromAccount: 'ACC-001',
          toAccount: 'ACC-002',
          amount: '20.00',
          currency: 'USD',
          idempotencyKey: 'acc-4-conflict',
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const after = await balances();
    expect(after['ACC-001']).toBe('9990.00');
  });

  it('5. transferencias cruzadas A→B y B→A quedan consistentes', async () => {
    await Promise.all([
      transfers.create(
        {
          fromAccount: 'ACC-001',
          toAccount: 'ACC-002',
          amount: '50.00',
          currency: 'USD',
          idempotencyKey: 'acc-5-ab',
        },
        randomUUID(),
      ),
      transfers.create(
        {
          fromAccount: 'ACC-002',
          toAccount: 'ACC-001',
          amount: '30.00',
          currency: 'USD',
          idempotencyKey: 'acc-5-ba',
        },
        randomUUID(),
      ),
    ]);
    const after = await balances();
    expect(after['ACC-001']).toBe('9980.00');
    expect(after['ACC-002']).toBe('5020.00');
  });

  it('6. si la IA falla la transferencia ya quedó COMPLETED y el evento pendiente', async () => {
    aiShouldFail = true;
    const result = await transfers.create(
      {
        fromAccount: 'ACC-001',
        toAccount: 'ACC-003',
        amount: '15.00',
        currency: 'USD',
        idempotencyKey: 'acc-6-ai-down',
      },
      randomUUID(),
    );
    expect(result.status).toBe('COMPLETED');
    await outbox.tick();
    const events = await prisma.outboxEvent.findMany({ where: { eventType: 'AI_RECOMMEND' } });
    expect(events).toHaveLength(1);
    expect(['PENDING', 'CLAIMED']).toContain(events[0].status);
    expect(await prisma.recommendation.count()).toBe(0);
    const after = await balances();
    expect(after['ACC-001']).toBe('9985.00');
  });

  it('7. el worker recupera un claim vencido sin duplicar recomendaciones', async () => {
    await transfers.create(
      {
        fromAccount: 'ACC-001',
        toAccount: 'ACC-002',
        amount: '5.00',
        currency: 'USD',
        idempotencyKey: 'acc-7-restart',
      },
      randomUUID(),
    );
    const claimed = await outbox.claimBatch();
    const aiEvent = claimed.find((event) => event.event_type === 'AI_RECOMMEND');
    expect(aiEvent).toBeDefined();
    await prisma.$executeRaw`
      UPDATE outbox_events
      SET claim_expires_at = now() - interval '1 second'
      WHERE id = ${aiEvent!.id}::uuid
    `;
    await outbox.tick();
    await outbox.tick();
    expect(await prisma.recommendation.count()).toBe(1);
    const done = await prisma.outboxEvent.findUnique({ where: { id: aiEvent!.id } });
    expect(done?.status).toBe('DONE');
  });

  it('8. el diagnóstico identifica la sesión que retiene el bloqueo', async () => {
    const hold = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM accounts WHERE account_number = 'ACC-001' FOR UPDATE`;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const waiter = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM accounts WHERE account_number = 'ACC-001' FOR UPDATE`;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const duringWait = await prisma.$queryRaw<Array<{ blocking_pid: number }>>`
      SELECT blocking.pid AS blocking_pid
      FROM pg_stat_activity blocked
      JOIN pg_stat_activity blocking ON blocking.pid = ANY (pg_blocking_pids(blocked.pid))
    `;
    await hold;
    await waiter;
    expect(duringWait.length).toBeGreaterThan(0);
  });

  it('expone health y crea transferencias por HTTP', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
    const response = await request(app.getHttpServer())
      .post('/api/v1/transfers')
      .set('content-type', 'application/json')
      .send({
        fromAccount: 'ACC-001',
        toAccount: 'ACC-002',
        amount: '2.00',
        currency: 'USD',
        idempotencyKey: 'http-ok-01',
      })
      .expect(201);
    expect(response.body.status).toBe('COMPLETED');
  });
});
