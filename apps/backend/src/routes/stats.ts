import type { FastifyInstance } from 'fastify';
import { prisma } from '../prisma';

export async function statsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/platform', async (_req, reply) => {
    const [totalPlayers, totalGames] = await Promise.all([
      prisma.user.count(),
      prisma.game.count({
        where: { status: { in: ['COMPLETED', 'FORFEITED'] } },
      }),
    ]);

    return reply.send({ totalPlayers, totalGames });
  });
}
