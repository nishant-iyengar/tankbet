import type { FastifyInstance } from 'fastify';
import { prisma } from '../prisma';
import { matchMaker } from '@colyseus/core';
import crypto from 'node:crypto';
import { LIVES_PER_TEST_GAME } from '@tankbet/game-engine/constants';
import { logger } from '../logger';
import { requireAuth } from '../middleware/auth';

const DEV_USERS = [
  { clerkId: 'dev-admin-1', phoneNumber: '+10000000001', username: 'fierce-crimson-falcon' },
  { clerkId: 'dev-admin-2', phoneNumber: '+10000000002', username: 'swift-azure-wolf' },
] as const;

export async function devRoutes(fastify: FastifyInstance): Promise<void> {
  // Seed dev users on route registration
  for (const devUser of DEV_USERS) {
    await prisma.user.upsert({
      where: { clerkId: devUser.clerkId },
      create: {
        clerkId: devUser.clerkId,
        username: devUser.username,
        phoneNumber: devUser.phoneNumber,
        balance: 0,
      },
      update: { phoneNumber: devUser.phoneNumber, username: devUser.username },
    });
  }

  // GET /api/dev/users — list seeded dev users
  fastify.get('/users', async (_req, reply) => {
    const users = await prisma.user.findMany({
      where: { clerkId: { in: DEV_USERS.map((u) => u.clerkId) } },
      select: { id: true, clerkId: true, username: true, phoneNumber: true },
    });
    return reply.send({ users });
  });

  // POST /api/dev/login — dev login by clerkId, upserts user in DB
  interface DevLoginBody { clerkId: string }
  fastify.post<{ Body: DevLoginBody }>('/login', async (req, reply) => {
    const { clerkId } = req.body;
    const devUser = DEV_USERS.find((u) => u.clerkId === clerkId);
    if (!devUser) {
      return reply.status(400).send({ error: 'Unknown dev user' });
    }

    const user = await prisma.user.upsert({
      where: { clerkId: devUser.clerkId },
      create: {
        clerkId: devUser.clerkId,
        username: devUser.username,
        phoneNumber: devUser.phoneNumber,
        balance: 0,
      },
      update: {},
    });

    return reply.send({ user });
  });

  // POST /api/dev/test-game — creates a live game + Colyseus room for authenticated dev user
  interface TestGameBody { opponentClerkId: string }
  fastify.post<{ Body: TestGameBody }>('/test-game', { preHandler: requireAuth }, async (req, reply) => {
    const creator = req.dbUser;
    const { opponentClerkId } = req.body;

    const opponent = await prisma.user.findUnique({ where: { clerkId: opponentClerkId } });
    if (!opponent) {
      return reply.status(400).send({ error: 'Opponent not found' });
    }

    if (creator.id === opponent.id) {
      return reply.status(400).send({ error: 'Cannot play against yourself' });
    }

    // Clear stale activeGameId on both players (in case a previous crashed game left state)
    await prisma.$transaction([
      prisma.user.update({
        where: { id: creator.id },
        data: { activeGameId: null },
      }),
      prisma.user.update({
        where: { id: opponent.id },
        data: { activeGameId: null },
      }),
    ]);

    const game = await prisma.game.create({
      data: {
        creatorId: creator.id,
        opponentId: opponent.id,
        betAmountCents: 0,
        status: 'IN_PROGRESS',
        startedAt: new Date(),
        inviteToken: crypto.randomBytes(16).toString('hex'),
        inviteExpiresAt: new Date(),
      },
    });

    const room = await matchMaker.createRoom('tank', {
      gameId: game.id,
      player1Id: creator.id,
      player2Id: opponent.id,
      lives: LIVES_PER_TEST_GAME,
    });

    await prisma.$transaction([
      prisma.game.update({
        where: { id: game.id },
        data: { colyseusRoomId: room.roomId },
      }),
      prisma.user.update({
        where: { id: creator.id },
        data: { activeGameId: game.id },
      }),
      prisma.user.update({
        where: { id: opponent.id },
        data: { activeGameId: game.id },
      }),
    ]);

    logger.info({ gameId: game.id, roomId: room.roomId, creatorId: creator.id, opponentId: opponent.id }, 'dev test game created');

    return reply.send({ gameId: game.id });
  });
}
