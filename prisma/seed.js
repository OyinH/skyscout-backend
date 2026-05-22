// prisma/seed.js
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create demo user
  const hashed = await bcrypt.hash('demo1234', 10);
  const user = await prisma.user.upsert({
    where: { email: 'demo@skyscout.app' },
    update: {},
    create: {
      email: 'demo@skyscout.app',
      password: hashed,
      name: 'Demo User',
      phone: '+15550001234',
    },
  });

  console.log(`✅ Created user: ${user.email}`);

  // Create sample alerts
  const alerts = await Promise.all([
    prisma.alert.upsert({
      where: { id: 'seed-alert-1' },
      update: {},
      create: {
        id: 'seed-alert-1',
        userId: user.id,
        origin: 'New York (JFK)',
        dest: 'London (LHR)',
        originCode: 'JFK',
        destCode: 'LHR',
        departDate: new Date('2026-07-06'),
        returnDate: new Date('2026-07-13'),
        cabin: 'ECONOMY',
        maxBudget: 1000,
        targetDrop: 10,
        checkFreq: 6,
        channels: 'email,browser',
        status: 'WATCHING',
        basePrice: 870,
        currentPrice: 820,
        lowestSeen: 790,
      },
    }),
    prisma.alert.upsert({
      where: { id: 'seed-alert-2' },
      update: {},
      create: {
        id: 'seed-alert-2',
        userId: user.id,
        origin: 'Los Angeles (LAX)',
        dest: 'Tokyo (NRT)',
        originCode: 'LAX',
        destCode: 'NRT',
        departDate: new Date('2026-09-10'),
        returnDate: new Date('2026-09-24'),
        cabin: 'BUSINESS',
        maxBudget: 4000,
        targetDrop: 15,
        checkFreq: 12,
        channels: 'email',
        status: 'DEAL_FOUND',
        basePrice: 2800,
        currentPrice: 2100,
        lowestSeen: 2050,
      },
    }),
  ]);

  // Seed price history for first alert
  const now = Date.now();
  const points = Array.from({ length: 30 }, (_, i) => ({
    alertId: alerts[0].id,
    price: 820 + Math.round((Math.random() - 0.45) * 60),
    airline: ['Norse Atlantic', 'Icelandair', 'JetBlue'][i % 3],
    source: 'ai_agent',
    dealScore: Math.floor(Math.random() * 40) + 50,
    checkedAt: new Date(now - (29 - i) * 86400000),
  }));

  await prisma.pricePoint.createMany({ data: points, skipDuplicates: true });

  console.log(`✅ Created ${alerts.length} alerts with price history`);
  console.log('\n📋 Demo credentials:');
  console.log('   Email: demo@skyscout.app');
  console.log('   Password: demo1234');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
