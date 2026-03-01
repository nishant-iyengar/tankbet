import type { FastifyInstance } from 'fastify';
import { prisma } from '../prisma';
import { matchMaker } from '@colyseus/core';
import crypto from 'node:crypto';
import { logger } from '../logger';

// Track pending reservations per (roomId, userId) to handle React StrictMode double-mount.
const pendingReservations = new Map<string, { sessionId: string; createdAt: number }>();
const RESERVATION_TTL_MS = 10_000;

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

  // POST /api/dev/test-game — creates two test users + a live game + a Colyseus room
  fastify.post('/test-game', async (_req, reply) => {
    const [player1, player2] = await Promise.all([
      prisma.user.upsert({
        where: { clerkId: 'dev-player-1' },
        create: { clerkId: 'dev-player-1', username: 'dev-player-1', phoneNumber: '+10000000099', balance: 0 },
        update: {},
      }),
      prisma.user.upsert({
        where: { clerkId: 'dev-player-2' },
        create: { clerkId: 'dev-player-2', username: 'dev-player-2', phoneNumber: '+10000000098', balance: 0 },
        update: {},
      }),
    ]);

    const game = await prisma.game.create({
      data: {
        creatorId: player1.id,
        opponentId: player2.id,
        betAmountCents: 0,
        status: 'IN_PROGRESS',
        startedAt: new Date(),
        inviteToken: crypto.randomBytes(16).toString('hex'),
        inviteExpiresAt: new Date(),
      },
    });

    const room = await matchMaker.createRoom('tank', {
      gameId: game.id,
      player1Id: player1.id,
      player2Id: player2.id,
    });

    await prisma.game.update({
      where: { id: game.id },
      data: { colyseusRoomId: room.roomId },
    });

    return reply.send({
      colyseusRoomId: room.roomId,
      player1Id: player1.id,
      player2Id: player2.id,
    });
  });

  // POST /api/dev/seat — generate a seat reservation for a dev game room.
  interface SeatBody { roomId: string; userId: string }
  fastify.post<{ Body: SeatBody }>('/seat', async (req, reply) => {
    const { roomId, userId } = req.body;

    const [listing] = await matchMaker.query({ roomId });
    logger.info({ roomId, userId, listing: listing ? { clients: listing.clients, maxClients: listing.maxClients, locked: listing.locked } : null }, 'seat request');
    if (!listing) return reply.status(404).send({ error: 'Room not found' });

    const key = `${roomId}:${userId}`;
    const now = Date.now();

    // Return existing reservation if within TTL (handles React StrictMode double-mount)
    const existing = pendingReservations.get(key);
    if (existing && now - existing.createdAt < RESERVATION_TTL_MS) {
      logger.info({ sessionId: existing.sessionId }, 'returning cached reservation');
      // Return the flat 0.17 seat reservation format
      return reply.send({
        sessionId: existing.sessionId,
        roomId: listing.roomId,
        name: listing.name,
        processId: listing.processId,
      });
    }

    try {
      const reservation = await matchMaker.reserveSeatFor(listing, {}, { userId });
      logger.info({ sessionId: reservation.sessionId }, 'reserved seat');
      pendingReservations.set(key, { sessionId: reservation.sessionId, createdAt: now });
      return reply.send(reservation);
    } catch (err) {
      logger.error({ err }, 'reserveSeatFor failed');
      throw err;
    }
  });
}
