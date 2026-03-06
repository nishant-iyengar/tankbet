import { matchMaker } from '@colyseus/core';
import { prisma } from '../prisma';
import { logger } from '../logger';
import {
  ORPHANED_GAME_THRESHOLD_MS,
  CLEANUP_JOB_INTERVAL_MS,
} from '@tankbet/game-engine/constants';

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
 *
 * Uses a consecutive-miss counter so a single transient matchMaker query
 * failure doesn't prematurely forfeit a live game.
 */
const ORPHAN_MISS_THRESHOLD = 2;
const orphanMissCount = new Map<string, number>();

export async function forfeitOrphanedGames(): Promise<number> {
  const cutoff = new Date(Date.now() - ORPHANED_GAME_THRESHOLD_MS);

  const orphanedGames = await prisma.game.findMany({
    where: {
      status: 'IN_PROGRESS',
      startedAt: { lt: cutoff },
    },
  });

  // Track which game IDs are still candidates so we can prune stale entries
  const currentCandidateIds = new Set(orphanedGames.map((g) => g.id));

  // Prune miss counts for games no longer in the candidate set
  for (const gameId of orphanMissCount.keys()) {
    if (!currentCandidateIds.has(gameId)) {
      orphanMissCount.delete(gameId);
    }
  }

  let forfeited = 0;

  for (const game of orphanedGames) {
    // Check if the Colyseus room is still alive — if so, reset miss count
    if (game.colyseusRoomId) {
      const [listing] = await matchMaker.query({ roomId: game.colyseusRoomId });
      if (listing) {
        orphanMissCount.delete(game.id);
        continue;
      }
    }

    // Room not found — increment miss counter
    const misses = (orphanMissCount.get(game.id) ?? 0) + 1;
    orphanMissCount.set(game.id, misses);

    if (misses < ORPHAN_MISS_THRESHOLD) {
      logger.info({ gameId: game.id, misses }, 'orphan candidate — waiting for consecutive confirmation');
      continue;
    }

    // Confirmed orphan — forfeit
    orphanMissCount.delete(game.id);

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

export function startGameCleanupJobs(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    expireStaleInvites().catch((err: unknown) => {
      logger.error({ err }, 'Failed to expire stale invites');
    });
    forfeitOrphanedGames().catch((err: unknown) => {
      logger.error({ err }, 'Failed to forfeit orphaned games');
    });
  }, CLEANUP_JOB_INTERVAL_MS);
}
