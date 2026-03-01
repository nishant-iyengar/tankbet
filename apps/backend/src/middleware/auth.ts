import type { FastifyRequest, FastifyReply } from 'fastify';
import { getAuth } from '@clerk/fastify';
import { prisma } from '../prisma';
import { isDev } from '../environment';
import type { User } from '@prisma/client';

declare module 'fastify' {
  interface FastifyRequest {
    dbUser: User;
  }
}

/**
 * Extract a dev user clerkId from the `Authorization: DevToken <clerkId>` header.
 * Returns null if not in dev mode or the header doesn't match.
 */
export function getDevClerkId(req: FastifyRequest): string | null {
  if (!isDev) return null;
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const match = /^DevToken\s+(.+)$/.exec(authHeader);
  return match ? match[1] : null;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // In dev mode, check for DevToken header first
  const devClerkId = getDevClerkId(req);
  if (devClerkId) {
    const user = await prisma.user.findUnique({ where: { clerkId: devClerkId } });
    if (!user) {
      reply.status(404).send({ error: 'Dev user not found' });
      return;
    }
    req.dbUser = user;
    return;
  }

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
