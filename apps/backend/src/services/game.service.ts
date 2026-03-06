import { matchMaker } from '@colyseus/core';
import { prisma } from '../prisma';
import { logger } from '../logger';

const ORPHANED_GAME_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

export async function expireStaleInvites(): Promise<number> {
  const now = new Date();

  const staleGames = await prisma.game.findMany({
    where: {
      status: 'PENDING_ACCEPTANCE',
      inviteExpiresAt: { lt: now },
    },
  });

  let expired = 0;

  for (const game of staleGames) {
    await prisma.$transaction([
      prisma.game.update({
        where: { id: game.id },
        data: { status: 'EXPIRED' },
      }),
      prisma.user.update({
        where: { id: game.creatorId },
        data: { activeGameId: null },
      }),
    ]);
    expired++;
  }

  return expired;
}

/**
 * Find IN_PROGRESS games whose Colyseus room no longer exists (server restart,
 * crash, or both players abandoned) and mark them as FORFEITED. Also catches
 * games that have been running longer than the threshold even if the room is
 * still alive — no legitimate game should last 15 minutes.
 */
export async function forfeitOrphanedGames(): Promise<number> {
  const cutoff = new Date(Date.now() - ORPHANED_GAME_THRESHOLD_MS);

  const orphanedGames = await prisma.game.findMany({
    where: {
      status: 'IN_PROGRESS',
      startedAt: { lt: cutoff },
    },
  });

  let forfeited = 0;

  for (const game of orphanedGames) {
    // Check if the Colyseus room is still alive — if so, skip it and let
    // the room handle its own lifecycle (grace period, forfeit, etc.)
    if (game.colyseusRoomId) {
      const [listing] = await matchMaker.query({ roomId: game.colyseusRoomId });
      if (listing) continue;
    }

    const playerIds = [game.creatorId, game.opponentId].filter(
      (pid): pid is string => pid !== null,
    );

    await prisma.$transaction([
      prisma.game.update({
        where: { id: game.id },
        data: { status: 'FORFEITED', endedAt: new Date() },
      }),
      ...playerIds.map((pid) =>
        prisma.user.update({
          where: { id: pid },
          data: { activeGameId: null },
        }),
      ),
    ]);

    logger.info({ gameId: game.id }, 'forfeited orphaned game');
    forfeited++;
  }

  return forfeited;
}

// Run every 30 seconds
export function startGameCleanupJobs(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    expireStaleInvites().catch((err: unknown) => {
      logger.error({ err }, 'Failed to expire stale invites');
    });
    forfeitOrphanedGames().catch((err: unknown) => {
      logger.error({ err }, 'Failed to forfeit orphaned games');
    });
  }, 30_000);
}
