import type { FastifyInstance } from 'fastify';
import { matchMaker } from '@colyseus/core';
import crypto from 'node:crypto';
import { isDraining } from '../drain';

export async function practiceRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/practice/start — create a single-player practice room and return a seat reservation.
  // No auth required; anyone can start a practice session.
  fastify.post('/start', async (_req, reply) => {
    if (isDraining()) {
      return reply.status(503).send({ error: 'Server is restarting — please try again in a moment' });
    }
    const userId = `practice-${crypto.randomUUID()}`;

    const room = await matchMaker.createRoom('practice', {});
    const [listing] = await matchMaker.query({ roomId: room.roomId });
    if (!listing) return reply.status(500).send({ error: 'Room not found after creation' });

    const reservation = await matchMaker.reserveSeatFor(listing, {}, { userId });

    return reply.send({ reservation, userId });
  });
}
