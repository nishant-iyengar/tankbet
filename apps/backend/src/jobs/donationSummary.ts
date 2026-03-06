// @ts-nocheck — file kept but deactivated (charity/betting removed)
import cron from 'node-cron';
import { clerkClient } from '@clerk/fastify';
import { prisma } from '../prisma.js';
import { sendSms } from '../services/sms.service.js';
import { formatCents } from '@tankbet/shared/utils';
import { logger } from '../logger';

// TODO: Register a Twilio phone number and configure it for A2P 10DLC
// (application-to-person messaging). You need:
//   1. A Twilio Messaging Service with a registered 10DLC campaign
//   2. Brand registration via Twilio's Trust Hub
//   3. Campaign use-case: "Tax-related donation reminders"
// Without 10DLC registration, carriers may filter/block these messages.

/**
 * Months of previous fiscal year (prior calendar year) to send reminders.
 * Sent Jan–Apr in the lead-up to the Apr 15 tax filing deadline.
 */
const REMINDER_MONTHS = [1, 2, 3, 4] as const;

function buildDonationSummaryMessage(
  totalCents: number,
  charityBreakdown: Array<{ charityName: string; totalCents: number }>,
  fiscalYear: number,
): string {
  const total = formatCents(totalCents);

  const breakdownLines = charityBreakdown
    .map((c) => `  • ${c.charityName}: ${formatCents(c.totalCents)}`)
    .join('\n');

  return [
    `TankBet: Your ${fiscalYear} donation summary`,
    '',
    `Total donated: ${total}`,
    '',
    breakdownLines,
    '',
    `These donations may be tax-deductible under 501(c)(3).`,
    `Visit tankbet.dev/tax-exemption for details and receipts.`,
    '',
    `Tax filing deadline: April 15, ${fiscalYear + 1}`,
  ].join('\n');
}

export async function runDonationSummaryJob(): Promise<void> {
  const now = new Date();
  const currentMonth = now.getMonth() + 1; // 1-indexed

  if (!REMINDER_MONTHS.includes(currentMonth as (typeof REMINDER_MONTHS)[number])) {
    logger.info('Donation summary job: not a reminder month, skipping');
    return;
  }

  const fiscalYear = now.getFullYear() - 1;
  const yearStart = new Date(fiscalYear, 0, 1);
  const yearEnd = new Date(fiscalYear + 1, 0, 1);

  // Get all users who donated in the previous fiscal year
  const userTotals = await prisma.contribution.groupBy({
    by: ['userId'],
    where: {
      createdAt: { gte: yearStart, lt: yearEnd },
      netAmountCents: { gt: 0 },
    },
    _sum: { netAmountCents: true },
  });

  const eligible = userTotals.filter(
    (row) => (row._sum.netAmountCents ?? 0) > 0,
  );

  logger.info(
    { fiscalYear, eligibleCount: eligible.length },
    'Donation summary job: starting',
  );

  for (const row of eligible) {
    try {
      const dbUser = await prisma.user.findUnique({
        where: { id: row.userId },
      });
      if (!dbUser) {
        logger.warn({ userId: row.userId }, 'Donation summary: DB user not found');
        continue;
      }

      const clerkUser = await clerkClient.users.getUser(dbUser.clerkId);
      const primaryPhone = clerkUser.phoneNumbers.find(
        (p) => p.id === clerkUser.primaryPhoneNumberId,
      );

      if (!primaryPhone?.phoneNumber) {
        logger.warn({ userId: row.userId }, 'Donation summary: no phone number, skipping');
        continue;
      }

      // Per-charity breakdown for this user in the fiscal year
      const charityTotals = await prisma.contribution.groupBy({
        by: ['charityId'],
        where: {
          userId: row.userId,
          createdAt: { gte: yearStart, lt: yearEnd },
          netAmountCents: { gt: 0 },
        },
        _sum: { netAmountCents: true },
      });

      const charityIds = charityTotals.map((c) => c.charityId);
      const charities = await prisma.charity.findMany({
        where: { id: { in: charityIds } },
        select: { id: true, name: true },
      });

      const charityNameMap = new Map(charities.map((c) => [c.id, c.name]));

      const breakdown = charityTotals
        .map((c) => ({
          charityName: charityNameMap.get(c.charityId) ?? 'Unknown Charity',
          totalCents: c._sum.netAmountCents ?? 0,
        }))
        .filter((c) => c.totalCents > 0)
        .sort((a, b) => b.totalCents - a.totalCents);

      const totalCents = row._sum.netAmountCents ?? 0;
      const message = buildDonationSummaryMessage(totalCents, breakdown, fiscalYear);

      await sendSms(primaryPhone.phoneNumber, message);
      logger.info(
        { userId: row.userId, totalCents, fiscalYear },
        'Donation summary SMS sent',
      );
    } catch (err) {
      logger.error({ err, userId: row.userId }, 'Donation summary failed for user');
    }
  }

  logger.info({ fiscalYear }, 'Donation summary job: complete');
}

export function scheduleDonationSummaryJob(): void {
  // 1st of every month at 10:00 AM UTC — the job itself checks if it's Jan–Apr
  cron.schedule('0 10 1 * *', () => {
    runDonationSummaryJob().catch((err: unknown) => {
      logger.error({ err }, 'Donation summary job unhandled error');
    });
  });
  logger.info('Donation summary job scheduled (1st of month, 10am UTC, active Jan–Apr)');
}
