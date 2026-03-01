import type { FastifyInstance } from 'fastify';
import { prisma } from '../prisma';
import { matchMaker } from '@colyseus/core';
import crypto from 'node:crypto';

// Track pending reservations per (roomId, userId) to handle React StrictMode double-mount.
const pendingReservations = new Map<string, { sessionId: string; createdAt: number }>();
const RESERVATION_TTL_MS = 10_000;

export async function devRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/dev/test-game — creates two test users + a live game + a Colyseus room
  fastify.post('/test-game', async (_req, reply) => {
    const [player1, player2] = await Promise.all([
      prisma.user.upsert({
        where: { clerkId: 'dev-player-1' },
        create: { clerkId: 'dev-player-1', username: 'dev-player-1', balance: 0 },
        update: {},
      }),
      prisma.user.upsert({
        where: { clerkId: 'dev-player-2' },
        create: { clerkId: 'dev-player-2', username: 'dev-player-2', balance: 0 },
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
    console.log(`[dev/seat] roomId=${roomId} userId=${userId} listing=${listing ? `found (clients=${listing.clients}/${listing.maxClients} locked=${String(listing.locked)})` : 'NOT FOUND'}`);
    if (!listing) return reply.status(404).send({ error: 'Room not found' });

    const key = `${roomId}:${userId}`;
    const now = Date.now();

    // Return existing reservation if within TTL (handles React StrictMode double-mount)
    const existing = pendingReservations.get(key);
    if (existing && now - existing.createdAt < RESERVATION_TTL_MS) {
      console.log(`[dev/seat] returning cached reservation sessionId=${existing.sessionId}`);
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
      console.log(`[dev/seat] reserved sessionId=${reservation.sessionId}`);
      pendingReservations.set(key, { sessionId: reservation.sessionId, createdAt: now });
      return reply.send(reservation);
    } catch (err) {
      console.error(`[dev/seat] reserveSeatFor FAILED:`, err);
      throw err;
    }
  });
}
