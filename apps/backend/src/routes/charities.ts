import type { FastifyInstance } from 'fastify';
import { prisma } from '../prisma';

export async function charityRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/charities — List all active charities
  fastify.get('/', async (_req, reply) => {
    const charities = await prisma.charity.findMany({
      where: { active: true },
      select: {
        id: true,
        name: true,
        logoUrl: true,
        description: true,
      },
      orderBy: { name: 'asc' },
    });

    return reply.send({ charities });
  });
}
