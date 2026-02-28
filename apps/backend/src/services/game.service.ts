import { prisma } from '../prisma';
import { logger } from '../logger';

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
        data: {
          reservedBalance: { decrement: game.betAmountCents },
          activeGameId: null,
        },
      }),
    ]);
    expired++;
  }

  return expired;
}

// Run every 30 seconds
export function startInviteExpiryJob(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    expireStaleInvites().catch((err: unknown) => {
      logger.error({ err }, 'Failed to expire stale invites');
    });
  }, 30_000);
}
