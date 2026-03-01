import type { FastifyInstance } from 'fastify';
import { getAuth, clerkClient } from '@clerk/fastify';
import { prisma } from '../prisma';
import { requireAuth, getDevClerkId } from '../middleware/auth';
import { generateUsername } from '@tankbet/shared/username';

export async function userRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/users/onboard — Create user after Clerk signup
  fastify.post('/onboard', async (req, reply) => {
    // Support DevToken auth in dev mode
    const devClerkId = getDevClerkId(req);
    const clerkAuth = devClerkId ? null : getAuth(req);
    const userId = devClerkId ?? clerkAuth?.userId;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    // Check if user already exists
    const existing = await prisma.user.findUnique({ where: { clerkId: userId } });
    if (existing) {
      return reply.status(200).send({ user: existing });
    }

    // Fetch phone number from Clerk (for real users) or DB (for dev users)
    let phoneNumber = '';
    if (!devClerkId) {
      const clerkUser = await clerkClient.users.getUser(userId);
      const primaryPhone = clerkUser.phoneNumbers.find(
        (p) => p.id === clerkUser.primaryPhoneNumberId,
      );
      phoneNumber = primaryPhone?.phoneNumber ?? '';
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
        phoneNumber,
      },
    });

    return reply.status(201).send({ user });
  });

  // GET /api/users/me — Fetch current user profile + balance
  fastify.get('/me', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.dbUser;

    let activeGame: { gameId: string; inviteToken: string; status: 'PENDING_ACCEPTANCE' | 'IN_PROGRESS' } | null = null;
    if (user.activeGameId) {
      const game = await prisma.game.findUnique({
        where: { id: user.activeGameId },
        select: { id: true, inviteToken: true, status: true },
      });
      if (game && (game.status === 'PENDING_ACCEPTANCE' || game.status === 'IN_PROGRESS')) {
        activeGame = { gameId: game.id, inviteToken: game.inviteToken, status: game.status };
      } else {
        // Stale activeGameId — game ended/expired but pointer wasn't cleared. Fix it.
        await prisma.user.update({
          where: { id: user.id },
          data: { activeGameId: null },
        });
      }
    }

    return reply.send({
      id: user.id,
      username: user.username,
      balance: user.balance - user.reservedBalance,
      totalDonatedCents: user.totalDonatedCents,
      hasBankAccount: user.stripePaymentMethodId !== null,
      activeGame,
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

  // GET /api/users/game-history — Paginated game history with filters
  interface GameHistoryQuery { cursor?: string; limit?: string; status?: string; result?: string; charityId?: string }
  fastify.get<{ Querystring: GameHistoryQuery }>('/game-history', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.dbUser;
    const query = req.query;
    const limit = Math.min(Number(query.limit) || 20, 50);

    // Build where clause: user is creator OR opponent
    const userFilter = { OR: [{ creatorId: user.id }, { opponentId: user.id }] };

    const statusFilter = query.status
      ? { status: query.status as 'PENDING_ACCEPTANCE' | 'IN_PROGRESS' | 'COMPLETED' | 'FORFEITED' | 'REJECTED' | 'EXPIRED' }
      : { status: { not: 'EXPIRED' as const } };

    const charityFilter = query.charityId
      ? { OR: [{ creatorCharityId: query.charityId }, { opponentCharityId: query.charityId }] }
      : {};

    // Result filter: WON or LOST relative to current user
    let resultFilter = {};
    if (query.result === 'WON') {
      resultFilter = { winnerId: user.id };
    } else if (query.result === 'LOST') {
      resultFilter = { loserId: user.id };
    }

    const where = { AND: [userFilter, statusFilter, charityFilter, resultFilter] };

    const games = await prisma.game.findMany({
      where,
      include: {
        creator: { select: { username: true } },
        opponent: { select: { username: true } },
        creatorCharity: { select: { id: true, name: true } },
        opponentCharity: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = games.length > limit;
    const items = hasMore ? games.slice(0, limit) : games;

    const entries = items.map((g) => {
      const isCreator = g.creatorId === user.id;
      const opponentUsername = isCreator
        ? (g.opponent?.username ?? 'Unknown')
        : g.creator.username;
      const charity = isCreator ? g.creatorCharity : g.opponentCharity;

      let result: 'WON' | 'LOST' | null = null;
      if (g.winnerId === user.id) result = 'WON';
      else if (g.loserId === user.id) result = 'LOST';

      return {
        id: g.id,
        opponentUsername,
        betAmountCents: g.betAmountCents,
        charityName: charity?.name ?? '',
        charityId: charity?.id ?? '',
        result,
        donationAmountCents: g.betAmountCents,
        durationSeconds: g.durationSeconds ?? null,
        status: g.status,
        endedAt: g.endedAt?.toISOString() ?? null,
        createdAt: g.createdAt.toISOString(),
      };
    });

    // Only fetch charities for filter dropdown on first page (no cursor)
    let charities: Array<{ id: string; name: string }> = [];
    if (!query.cursor) {
      const userGames = await prisma.game.findMany({
        where: { OR: [{ creatorId: user.id }, { opponentId: user.id }] },
        select: {
          creatorCharityId: true,
          opponentCharityId: true,
          creatorId: true,
        },
      });

      const charityIds = new Set<string>();
      for (const g of userGames) {
        const relevantCharityId = g.creatorId === user.id ? g.creatorCharityId : g.opponentCharityId;
        if (relevantCharityId) charityIds.add(relevantCharityId);
      }

      if (charityIds.size > 0) {
        charities = await prisma.charity.findMany({
          where: { id: { in: [...charityIds] } },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        });
      }
    }

    return reply.send({
      entries,
      nextCursor: hasMore ? items[items.length - 1].id : null,
      charities,
    });
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
