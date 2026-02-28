import type { FastifyRequest, FastifyReply } from 'fastify';
import { getAuth } from '@clerk/fastify';
import { prisma } from '../prisma';
import type { User } from '@prisma/client';

declare module 'fastify' {
  interface FastifyRequest {
    dbUser: User;
  }
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { userId } = getAuth(req);
  if (!userId) {
    reply.status(401).send({ error: 'Unauthorized' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { clerkId: userId } });
  if (!user) {
    reply.status(404).send({ error: 'User not found' });
    return;
  }

  req.dbUser = user;
}
