import type { FastifyInstance } from 'fastify';
import { prisma } from '../prisma';
import { requireAuth } from '../middleware/auth';
import { INVITE_EXPIRY_SECONDS } from '@tankbet/game-engine/constants';
import crypto from 'node:crypto';
import { isBetAmount } from '@tankbet/shared/utils';
import { matchMaker } from '@colyseus/core';
import { HttpError } from '../errors';
import { isBeta } from '../environment';

export async function gameRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/games/create — Create invite
  interface CreateGameBody { betAmountCents: number; charityId: string | null }
  fastify.post<{ Body: CreateGameBody }>('/create', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.dbUser;
    const body = req.body;

    if (!isBeta && !isBetAmount(body.betAmountCents)) {
      return reply.status(400).send({ error: 'Invalid bet amount' });
    }

    // Check user doesn't have an active game
    if (user.activeGameId) {
      return reply.status(400).send({ error: 'You already have an active game' });
    }

    // Verify charity exists (skip in beta)
    if (!isBeta) {
      const charity = body.charityId ? await prisma.charity.findUnique({ where: { id: body.charityId } }) : null;
      if (!charity || !charity.active) {
        return reply.status(400).send({ error: 'Invalid charity' });
      }
    }

    const betAmountCents = isBeta ? 0 : body.betAmountCents;
    const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const tokenBytes = crypto.randomBytes(6);
    const inviteToken = Array.from(tokenBytes, (b) => TOKEN_CHARS[b % TOKEN_CHARS.length]!).join('');
    const inviteExpiresAt = new Date(Date.now() + INVITE_EXPIRY_SECONDS * 1000);

    let game: Awaited<ReturnType<typeof prisma.game.create>>;
    try {
      game = await prisma.$transaction(async (tx) => {
        if (!isBeta) {
          const freshUser = await tx.user.findUnique({ where: { id: user.id } });
          if (!freshUser) throw new HttpError(404, 'User not found');
          const availableBalance = freshUser.balance - freshUser.reservedBalance;
          if (availableBalance < betAmountCents) {
            throw new HttpError(400, 'Insufficient balance');
          }
        }

        const created = await tx.game.create({
          data: {
            creatorId: user.id,
            betAmountCents,
            creatorCharityId: isBeta ? null : body.charityId,
            status: 'PENDING_ACCEPTANCE',
            inviteToken,
            inviteExpiresAt,
          },
        });

        await tx.user.update({
          where: { id: user.id },
          data: {
            reservedBalance: isBeta ? undefined : { increment: betAmountCents },
            activeGameId: created.id,
          },
        });

        return created;
      });
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send({ error: err.message });
      }
      throw err;
    }

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
      betAmountCents: game.betAmountCents,
      creatorUsername: game.creator.username,
      inviteExpiresAt: game.inviteExpiresAt.toISOString(),
      status: game.status,
    });
  });

  // POST /api/games/invite/:token/accept — Accept invite
  interface AcceptInviteBody { charityId: string }
  fastify.post<{ Params: InviteParams; Body: AcceptInviteBody }>('/invite/:token/accept', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.dbUser;
    const params = req.params;
    const body = req.body;

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

    // Verify charity (skip in beta)
    if (!isBeta) {
      const charity = await prisma.charity.findUnique({ where: { id: body.charityId } });
      if (!charity || !charity.active) {
        return reply.status(400).send({ error: 'Invalid charity' });
      }
    }

    try {
      await prisma.$transaction(async (tx) => {
        if (!isBeta) {
          const freshUser = await tx.user.findUnique({ where: { id: user.id } });
          if (!freshUser) throw new HttpError(404, 'User not found');
          const availableBalance = freshUser.balance - freshUser.reservedBalance;
          if (availableBalance < game.betAmountCents) {
            throw new HttpError(400, 'Insufficient balance');
          }
        }

        await tx.game.update({
          where: { id: game.id },
          data: {
            opponentId: user.id,
            opponentCharityId: body.charityId,
            status: 'IN_PROGRESS',
            startedAt: new Date(),
          },
        });

        await tx.user.update({
          where: { id: user.id },
          data: {
            reservedBalance: { increment: game.betAmountCents },
            activeGameId: game.id,
          },
        });
      });
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send({ error: err.message });
      }
      throw err;
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
        data: {
          reservedBalance: isBeta ? undefined : { decrement: game.betAmountCents },
          activeGameId: null,
        },
      });
    });

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
        data: {
          reservedBalance: isBeta ? undefined : { decrement: game.betAmountCents },
          activeGameId: null,
        },
      }),
    ]);

    return reply.send({ success: true });
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
        creatorCharity: { select: { id: true, name: true, logoUrl: true } },
        opponentCharity: { select: { id: true, name: true, logoUrl: true } },
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
    const seatReservation = listing
      ? await matchMaker.reserveSeatFor(listing, {}, { userId: user.id })
      : null;
    return reply.send({ game, playerIndex, seatReservation });
  });
}
