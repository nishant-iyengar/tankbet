import { prisma } from '../prisma';
import { logger } from '../logger';

const PLEDGE_API_URL = 'https://api.pledge.to/v1';
const PLEDGE_API_KEY = process.env['PLEDGE_API_KEY'] ?? '';

interface PledgeDonationResponse {
  id: string;
  status: string;
}

export async function disburseToPledge(
  charitySlug: string,
  amountCents: number,
  contributionIds: string[],
): Promise<string> {
  const response = await fetch(`${PLEDGE_API_URL}/donations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PLEDGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      nonprofit_slug: charitySlug,
      amount: amountCents,
      currency: 'usd',
      metadata: {
        contributionIds: contributionIds.join(','),
        source: 'tankbet',
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Pledge.to API error: ${response.status} ${errorText}`);
  }

  const data = await response.json() as PledgeDonationResponse;
  return data.id;
}

export async function runDisbursementBatch(): Promise<number> {
  // Group pending contributions by charity
  const pendingContributions = await prisma.contribution.findMany({
    where: { disbursementId: null },
    include: { charity: true },
  });

  // Group by charityId
  const grouped = new Map<string, typeof pendingContributions>();
  for (const c of pendingContributions) {
    const existing = grouped.get(c.charityId) ?? [];
    existing.push(c);
    grouped.set(c.charityId, existing);
  }

  let disbursed = 0;

  for (const [charityId, contributions] of grouped) {
    const totalAmountCents = contributions.reduce((sum, c) => sum + c.netAmountCents, 0);
    const charity = contributions[0].charity;

    if (!charity.pledgeSlug) {
      logger.warn({ charityName: charity.name }, 'Charity has no pledgeSlug, skipping disbursement');
      continue;
    }

    try {
      const pledgeDonationId = await disburseToPledge(
        charity.pledgeSlug,
        totalAmountCents,
        contributions.map((c) => c.id),
      );

      const disbursement = await prisma.disbursement.create({
        data: {
          charityId,
          totalAmountCents,
          pledgeDonationId,
          status: 'PROCESSING',
        },
      });

      await prisma.contribution.updateMany({
        where: { id: { in: contributions.map((c) => c.id) } },
        data: { disbursementId: disbursement.id },
      });

      await prisma.disbursement.update({
        where: { id: disbursement.id },
        data: { status: 'COMPLETED', disbursedAt: new Date() },
      });

      disbursed++;
    } catch (err) {
      logger.error({ err, charityName: charity.name }, 'Failed to disburse to charity');

      await prisma.disbursement.create({
        data: {
          charityId,
          totalAmountCents,
          status: 'FAILED',
        },
      });
    }
  }

  return disbursed;
}
