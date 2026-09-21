import { PrismaClient } from '@prisma/client';
import { DEMO_ACCOUNTS, generateUniqueAccounts } from './generate-accounts';

const prisma = new PrismaClient();

async function main() {
  const accounts = generateUniqueAccounts(10_000);

  for (const account of DEMO_ACCOUNTS) {
    await prisma.account.upsert({
      where: { id: account.id },
      update: {
        accountNumber: account.accountNumber,
        holderName: account.holderName,
        currency: account.currency,
      },
      create: account,
    });
  }

  const extras = accounts.filter((account) => !DEMO_ACCOUNTS.some((demo) => demo.id === account.id));
  const batchSize = 500;
  for (let i = 0; i < extras.length; i += batchSize) {
    const batch = extras.slice(i, i + batchSize);
    await prisma.account.createMany({
      data: batch,
      skipDuplicates: true,
    });
  }

  const count = await prisma.account.count();
  console.log(JSON.stringify({ seeded: count, uniqueHolders: accounts.length }));
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
