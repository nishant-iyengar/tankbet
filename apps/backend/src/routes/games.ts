import type { FastifyInstance } from 'fastify';
import { prisma } from '../prisma';
import { requireAuth } from '../middleware/auth';
import { INVITE_EXPIRY_SECONDS } from '@tankbet/game-engine/constants';
import crypto from 'node:crypto';
import { matchMaker } from '@colyseus/core';
import { subscribe, unsubscribe, notify } from '../services/inviteEvents';
import { isDraining } from '../drain';

export async function gameRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/games/create — Create invite
  fastify.post('/create', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.dbUser;

    // Check user doesn't have an active game
    if (user.activeGameId) {
      return reply.status(400).send({ error: 'You already have an active game' });
    }

    const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const tokenBytes = crypto.randomBytes(6);
    const inviteToken = Array.from(tokenBytes, (b) => TOKEN_CHARS[b % TOKEN_CHARS.length]!).join('');
    const inviteExpiresAt = new Date(Date.now() + INVITE_EXPIRY_SECONDS * 1000);

    const game = await prisma.$transaction(async (tx) => {
      const created = await tx.game.create({
        data: {
          creatorId: user.id,
          betAmountCents: 0,
          creatorCharityId: null,
          status: 'PENDING_ACCEPTANCE',
          inviteToken,
          inviteExpiresAt,
        },
      });

      await tx.user.update({
        where: { id: user.id },
        data: { activeGameId: created.id },
      });

      return created;
    });

    return reply.status(201).send({
      gameId: game.id,
      inviteToken: game.inviteToken,
      inviteExpiresAt: game.inviteExpiresAt.toISOString(),
    });
  });

  // GET /api/games/invite/:token — Fetch invite preview (unauthed)
  interface InviteParams { token: string }
  fastify.get<{ Params: InviteParams }>('/invite/:token', async (req, reply) => {
    const params = req.params;

    const game = await prisma.game.findUnique({
      where: { inviteToken: params.token },
      include: { creator: true },
    });

    if (!game) {
      return reply.status(404).send({ error: 'Invite not found' });
    }

    return reply.send({
      id: game.id,
      creatorUsername: game.creator.username,
      inviteExpiresAt: game.inviteExpiresAt.toISOString(),
      status: game.status,
    });
  });

  // POST /api/games/invite/:token/accept — Accept invite
  fastify.post<{ Params: InviteParams }>('/invite/:token/accept', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.dbUser;
    const params = req.params;

    const game = await prisma.game.findUnique({
      where: { inviteToken: params.token },
    });

    if (!game) {
      return reply.status(404).send({ error: 'Invite not found' });
    }

    if (game.status !== 'PENDING_ACCEPTANCE') {
      return reply.status(400).send({ error: 'Invite is no longer available' });
    }

    if (new Date() > game.inviteExpiresAt) {
      return reply.status(400).send({ error: 'Invite has expired' });
    }

    if (game.creatorId === user.id) {
      return reply.status(400).send({ error: 'Cannot accept your own invite' });
    }

    if (user.activeGameId) {
      return reply.status(400).send({ error: 'You already have an active game' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.game.update({
        where: { id: game.id },
        data: {
          opponentId: user.id,
          opponentCharityId: null,
          status: 'IN_PROGRESS',
          startedAt: new Date(),
        },
      });

      await tx.user.update({
        where: { id: user.id },
        data: { activeGameId: game.id },
      });
    });

    if (isDraining()) {
      // Roll back game status so users can retry after the new machine is up
      await prisma.$transaction([
        prisma.game.update({ where: { id: game.id }, data: { status: 'PENDING_ACCEPTANCE', opponentId: null, startedAt: null } }),
        prisma.user.update({ where: { id: user.id }, data: { activeGameId: null } }),
      ]);
      return reply.status(503).send({ error: 'Server is restarting — please try again in a moment' });
    }

    const room = await matchMaker.createRoom('tank', {
      gameId: game.id,
      player1Id: game.creatorId,
      player2Id: user.id,
    });
    await prisma.game.update({
      where: { id: game.id },
      data: { colyseusRoomId: room.roomId },
    });

    notify(game.id, { event: 'accepted', gameId: game.id });

    return reply.send({ gameId: game.id, colyseusRoomId: room.roomId });
  });

  // POST /api/games/invite/:token/reject — Reject invite
  fastify.post<{ Params: InviteParams }>('/invite/:token/reject', async (req, reply) => {
    const params = req.params;

    const game = await prisma.game.findUnique({
      where: { inviteToken: params.token },
    });

    if (!game) {
      return reply.status(404).send({ error: 'Invite not found' });
    }

    if (game.status !== 'PENDING_ACCEPTANCE') {
      return reply.status(400).send({ error: 'Invite is no longer available' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.game.update({
        where: { id: game.id },
        data: { status: 'REJECTED' },
      });

      await tx.user.update({
        where: { id: game.creatorId },
        data: { activeGameId: null },
      });
    });

    notify(game.id, { event: 'rejected' });

    return reply.send({ success: true });
  });

  // POST /api/games/invite/:token/cancel — Creator cancels their own pending invite
  fastify.post<{ Params: InviteParams }>('/invite/:token/cancel', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.dbUser;
    const params = req.params;

    const game = await prisma.game.findUnique({ where: { inviteToken: params.token } });

    if (!game) return reply.status(404).send({ error: 'Invite not found' });
    if (game.creatorId !== user.id) return reply.status(403).send({ error: 'Not the creator' });
    if (game.status !== 'PENDING_ACCEPTANCE') return reply.status(400).send({ error: 'Invite is not pending' });

    await prisma.$transaction([
      prisma.game.update({ where: { id: game.id }, data: { status: 'EXPIRED' } }),
      prisma.user.update({
        where: { id: user.id },
        data: { activeGameId: null },
      }),
    ]);

    notify(game.id, { event: 'cancelled' });

    return reply.send({ success: true });
  });

  // GET /api/games/invite/:token/events — SSE stream for invite status updates
  fastify.get<{ Params: InviteParams }>('/invite/:token/events', async (req, reply) => {
    const params = req.params;

    const game = await prisma.game.findUnique({
      where: { inviteToken: params.token },
    });

    if (!game) {
      return reply.status(404).send({ error: 'Invite not found' });
    }

    if (game.status !== 'PENDING_ACCEPTANCE') {
      return reply.status(400).send({ error: 'Invite is not pending' });
    }

    const origin = req.headers.origin ?? '*';
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
    });

    // Confirm connection
    reply.raw.write(':ok\n\n');

    subscribe(game.id, reply.raw);

    req.raw.on('close', () => {
      unsubscribe(game.id, reply.raw);
    });

    // Prevent Fastify from closing the response
    await reply.hijack();
  });

  // GET /api/games/:id — Fetch game state (for reconnect)
  interface GameIdParams { id: string }
  fastify.get<{ Params: GameIdParams }>('/:id', { preHandler: requireAuth }, async (req, reply) => {
    const params = req.params;
    const user = req.dbUser;

    const game = await prisma.game.findUnique({
      where: { id: params.id },
      include: {
        creator: { select: { id: true, username: true } },
        opponent: { select: { id: true, username: true } },
      },
    });

    if (!game) {
      return reply.status(404).send({ error: 'Game not found' });
    }

    if (game.creatorId !== user.id && game.opponentId !== user.id) {
      return reply.status(403).send({ error: 'Not a participant in this game' });
    }

    const playerIndex: 0 | 1 = game.creatorId === user.id ? 0 : 1;

    if (!game.colyseusRoomId) {
      return reply.send({ game, playerIndex, seatReservation: null });
    }

    const [listing] = await matchMaker.query({ roomId: game.colyseusRoomId });
    if (!listing) {
      // Room is gone — don't forfeit here; the cleanup job handles orphaned games.
      return reply.send({ game, playerIndex, seatReservation: null });
    }

    try {
      const seatReservation = await matchMaker.reserveSeatFor(listing, {}, { userId: user.id });
      return reply.send({ game, playerIndex, seatReservation });
    } catch {
      // Room is full — seat is likely held by allowReconnection for this player.
      // Return null so the client can try reconnecting via stored token instead.
      return reply.send({ game, playerIndex, seatReservation: null });
    }
  });
}
