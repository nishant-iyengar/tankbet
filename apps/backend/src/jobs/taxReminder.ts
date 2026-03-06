// @ts-nocheck — file kept but deactivated (charity/betting removed)
import cron from 'node-cron';
import { clerkClient } from '@clerk/fastify';
import { prisma } from '../prisma.js';
import { sendSms } from '../services/sms.service.js';
import { formatCents } from '@tankbet/shared/utils';
import { logger } from '../logger';

export async function runTaxReminderJob(): Promise<void> {
  const now = new Date();
  const year = now.getFullYear();
  const yearStart = new Date(year, 0, 1);

  const grouped = await prisma.contribution.groupBy({
    by: ['userId'],
    where: { createdAt: { gte: yearStart }, role: 'WINNER' },
    _sum: { netAmountCents: true },
  });

  const eligible = grouped.filter(
    (row) => (row._sum.netAmountCents ?? 0) > 0,
  );

  for (const row of eligible) {
    try {
      const dbUser = await prisma.user.findUnique({ where: { id: row.userId } });
      if (!dbUser) {
        logger.warn({ userId: row.userId }, 'Tax reminder: DB user not found');
        continue;
      }

      const clerkUser = await clerkClient.users.getUser(dbUser.clerkId);
      const primaryPhone = clerkUser.phoneNumbers.find(
        (p) => p.id === clerkUser.primaryPhoneNumberId,
      );

      if (!primaryPhone?.phoneNumber) {
        logger.warn({ userId: row.userId }, 'Tax reminder: no phone number, skipping');
        continue;
      }

      const totalCents = row._sum.netAmountCents ?? 0;
      const formattedAmount = formatCents(totalCents);
      const message =
        `TankBet: You've donated ${formattedAmount} to charity so far in ${year} — ` +
        `potentially tax-deductible under 501(c)(3). Visit tankbet.dev/tax-exemption for details.`;

      await sendSms(primaryPhone.phoneNumber, message);
      logger.info({ userId: row.userId, formattedAmount }, 'Tax reminder SMS sent');
    } catch (err) {
      logger.error({ err, userId: row.userId }, 'Tax reminder failed for user');
    }
  }
}

export function scheduleTaxReminderJob(): void {
  cron.schedule('0 0 1 10,11,12 *', () => {
    runTaxReminderJob().catch((err: unknown) => {
      logger.error({ err }, 'Tax reminder job unhandled error');
    });
  });
  logger.info('Tax reminder job scheduled (Oct 1, Nov 1, Dec 1 at midnight)');
}
