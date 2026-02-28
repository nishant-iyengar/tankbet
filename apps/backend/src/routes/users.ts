import type { FastifyInstance } from 'fastify';
import { getAuth } from '@clerk/fastify';
import { prisma } from '../prisma';
import { requireAuth } from '../middleware/auth';
import { generateUsername } from '@tankbet/shared/username';

export async function userRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/users/onboard — Create user after Clerk signup
  fastify.post('/onboard', async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    // Check if user already exists
    const existing = await prisma.user.findUnique({ where: { clerkId: userId } });
    if (existing) {
      return reply.status(200).send({ user: existing });
    }

    // Generate unique username with retry on collision
    let username = generateUsername();
    let retries = 0;
    while (retries < 10) {
      const collision = await prisma.user.findUnique({ where: { username } });
      if (!collision) break;
      username = generateUsername();
      retries++;
    }

    const user = await prisma.user.create({
      data: {
        clerkId: userId,
        username,
      },
    });

    return reply.status(201).send({ user });
  });

  // GET /api/users/me — Fetch current user profile + balance
  fastify.get('/me', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.dbUser;
    return reply.send({
      id: user.id,
      username: user.username,
      balance: user.balance - user.reservedBalance,
      totalDonatedCents: user.totalDonatedCents,
      hasBankAccount: user.stripePaymentMethodId !== null,
    });
  });

  // POST /api/users/accept-tos — Record ToS acceptance
  interface AcceptTosBody { version: string; userAgent: string }
  fastify.post<{ Body: AcceptTosBody }>('/accept-tos', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.dbUser;
    const body = req.body;

    const ip = req.ip;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        tosAcceptedAt: new Date(),
        tosAcceptedIp: ip,
        tosAcceptedVersion: body.version,
        tosUserAgent: body.userAgent,
      },
    });

    return reply.send({ success: true });
  });

  // GET /api/users/donation-history — Paginated donation history
  interface DonationHistoryQuery { cursor?: string; limit?: string }
  fastify.get<{ Querystring: DonationHistoryQuery }>('/donation-history', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.dbUser;
    const query = req.query;
    const limit = Math.min(Number(query.limit) || 20, 50);

    const contributions = await prisma.contribution.findMany({
      where: { userId: user.id },
      include: {
        charity: true,
        game: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = contributions.length > limit;
    const items = hasMore ? contributions.slice(0, limit) : contributions;

    const entries = items.map((c) => ({
      gameId: c.gameId,
      role: c.role,
      charityName: c.charity.name,
      charityLogoUrl: c.charity.logoUrl,
      betAmountCents: c.betAmountCents,
      netAmountCents: c.netAmountCents,
      displayAmountCents: c.role === 'WINNER' ? c.netAmountCents * 2 : c.netAmountCents,
      createdAt: c.createdAt.toISOString(),
    }));

    return reply.send({
      entries,
      nextCursor: hasMore ? items[items.length - 1].id : null,
    });
  });
}
