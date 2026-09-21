import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { AccountsService } from './accounts.service';

@Controller('api/v1/accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  list(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('q') q?: string,
  ) {
    return this.accounts.list({
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      q,
    });
  }

  @Get(':accountNumber')
  async get(@Param('accountNumber') accountNumber: string) {
    const account = await this.accounts.getByNumber(accountNumber);
    if (!account) {
      throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND' });
    }
    return account;
  }

  @Get(':accountNumber/transfers')
  async transfers(@Param('accountNumber') accountNumber: string) {
    const rows = await this.accounts.transfers(accountNumber);
    if (!rows) {
      throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND' });
    }
    return rows;
  }

  @Get(':accountNumber/recommendations')
  async recommendations(@Param('accountNumber') accountNumber: string) {
    const rows = await this.accounts.recommendations(accountNumber);
    if (!rows) {
      throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND' });
    }
    return rows;
  }
}
