import { Injectable } from '@nestjs/common';
import { formatMoney } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: { limit?: number; offset?: number; q?: string }) {
    const take = Math.min(Math.max(query.limit ?? 50, 1), 10_000);
    const skip = Math.max(query.offset ?? 0, 0);
    const q = query.q?.trim();
    const where = q
      ? {
          OR: [
            { accountNumber: { contains: q, mode: 'insensitive' as const } },
            { holderName: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : undefined;
    const [total, accounts] = await Promise.all([
      this.prisma.account.count({ where }),
      this.prisma.account.findMany({
        where,
        orderBy: { accountNumber: 'asc' },
        take,
        skip,
      }),
    ]);
    return {
      total,
      limit: take,
      offset: skip,
      items: accounts.map((account) => this.toResponse(account)),
    };
  }

  async getByNumber(accountNumber: string) {
    const account = await this.prisma.account.findUnique({ where: { accountNumber } });
    return account ? this.toResponse(account) : null;
  }

  async transfers(accountNumber: string) {
    const account = await this.prisma.account.findUnique({ where: { accountNumber } });
    if (!account) {
      return null;
    }
    const rows = await this.prisma.transfer.findMany({
      where: { OR: [{ fromAccountId: account.id }, { toAccountId: account.id }] },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { fromAccount: true, toAccount: true },
    });
    return rows.map((row) => ({
      id: row.id,
      correlationId: row.correlationId,
      fromAccount: row.fromAccount.accountNumber,
      toAccount: row.toAccount.accountNumber,
      amount: formatMoney(row.amount.toString()),
      currency: row.currency.trim(),
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async recommendations(accountNumber: string) {
    const account = await this.prisma.account.findUnique({ where: { accountNumber } });
    if (!account) {
      return null;
    }
    const rows = await this.prisma.recommendation.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return rows.map((row) => ({
      id: row.id,
      message: row.message,
      category: row.category,
      confidence: row.confidence.toString(),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private toResponse(account: { id: string; accountNumber: string; holderName: string; balance: { toString(): string }; currency: string }) {
    return {
      id: account.id,
      accountNumber: account.accountNumber,
      holderName: account.holderName,
      balance: formatMoney(account.balance.toString()),
      currency: account.currency.trim(),
    };
  }
}
