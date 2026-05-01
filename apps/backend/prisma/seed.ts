import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

interface CharitySeedData {
  name: string;
  ein: string;
  logoUrl: string;
  website: string;
  description: string;
}

const charities: CharitySeedData[] = [
  { name: 'American Red Cross', ein: '53-0196605', logoUrl: 'https://logo.clearbit.com/redcross.org', website: 'https://redcross.org', description: 'Disaster relief and emergency assistance.' },
  { name: 'ASPCA', ein: '13-1623829', logoUrl: 'https://logo.clearbit.com/aspca.org', website: 'https://aspca.org', description: 'Preventing cruelty to animals.' },
  { name: 'Doctors Without Borders', ein: '13-3433452', logoUrl: 'https://logo.clearbit.com/msf.org', website: 'https://msf.org', description: 'Medical aid in crisis zones worldwide.' },
  { name: 'St. Jude Research Hospital', ein: '35-1044585', logoUrl: 'https://logo.clearbit.com/stjude.org', website: 'https://stjude.org', description: "Pioneering research for children's cancer." },
  { name: 'World Wildlife Fund', ein: '52-1693387', logoUrl: 'https://logo.clearbit.com/worldwildlife.org', website: 'https://worldwildlife.org', description: 'Protecting nature and wildlife globally.' },
  { name: 'Feeding America', ein: '36-3673599', logoUrl: 'https://logo.clearbit.com/feedingamerica.org', website: 'https://feedingamerica.org', description: 'The largest domestic hunger-relief org.' },
  { name: 'Habitat for Humanity', ein: '91-1914868', logoUrl: 'https://logo.clearbit.com/habitat.org', website: 'https://habitat.org', description: 'Building affordable homes for families.' },
  { name: 'NAMI', ein: '43-1201653', logoUrl: 'https://logo.clearbit.com/nami.org', website: 'https://nami.org', description: 'Mental health education and advocacy.' },
  { name: 'Boys & Girls Clubs of America', ein: '13-5562976', logoUrl: 'https://logo.clearbit.com/bgca.org', website: 'https://bgca.org', description: 'Safe spaces for young people to grow.' },
  { name: 'Make-A-Wish Foundation', ein: '86-0418982', logoUrl: 'https://logo.clearbit.com/wish.org', website: 'https://wish.org', description: 'Granting wishes for children with illnesses.' },
];

async function main(): Promise<void> {
  console.log('Seeding charities...');

  for (const charity of charities) {
    await prisma.charity.upsert({
      where: { ein: charity.ein },
      update: charity,
      create: charity,
    });
  }

  console.log(`Seeded ${charities.length} charities.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e: unknown) => {
    console.error(e);
    void prisma.$disconnect();
    process.exit(1);
  });
