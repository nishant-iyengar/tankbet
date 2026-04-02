import Fastify from 'fastify';
import cors from '@fastify/cors';
import { clerkPlugin } from '@clerk/fastify';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { userRoutes } from './routes/users';
import { gameRoutes } from './routes/games';
import { TankRoom } from './rooms/TankRoom';
import { PracticeRoom } from './rooms/PracticeRoom';
import { practiceRoutes } from './routes/practice';
import { statsRoutes } from './routes/stats';
import { startGameCleanupJobs } from './services/game.service';
import { env, isDev } from './environment';
import { logger } from './logger';

const fastify = Fastify({ loggerInstance: logger });

async function start(): Promise<void> {
  await fastify.register(cors, {
    origin: isDev ? true : env.frontendUrl,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await fastify.register(clerkPlugin, {
    publishableKey: env.clerkPublishableKey,
    secretKey: env.clerkSecretKey,
  });

  // Health check (used by Railway)
  fastify.get('/health', async (_req, reply) => reply.send({ status: 'ok' }));

  // Route registration
  await fastify.register(userRoutes, { prefix: '/api/users' });
  await fastify.register(gameRoutes, { prefix: '/api/games' });
  await fastify.register(practiceRoutes, { prefix: '/api/practice' });
  await fastify.register(statsRoutes, { prefix: '/api/stats' });

  if (isDev) {
    const { devRoutes } = await import('./routes/dev');
    await fastify.register(devRoutes, { prefix: '/api/dev' });
  }

  const cleanupHandle = startGameCleanupJobs();

  const shutdown = (): void => {
    clearInterval(cleanupHandle);
    logger.info('Cleanup jobs stopped');
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Colyseus matchmaker reconnect route — the SDK's client.reconnect() POSTs
  // here but WebSocketTransport only handles WS upgrades, not HTTP matchmaking.
  interface ReconnectParams { roomId: string }
  interface ReconnectBody { reconnectionToken: string }
  fastify.post<{ Params: ReconnectParams; Body: ReconnectBody }>(
    '/matchmake/reconnect/:roomId',
    async (req, reply) => {
      try {
        const result = await matchMaker.reconnect(req.params.roomId, req.body);
        return reply.send(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Reconnection failed';
        return reply.status(500).send({ error: message });
      }
    },
  );

  // Attach Colyseus to the same HTTP server as Fastify
  const gameServer = new Server({ transport: new WebSocketTransport({ server: fastify.server }) });
  gameServer.define('tank', TankRoom);
  gameServer.define('practice', PracticeRoom);

  await fastify.listen({ port: env.port, host: '0.0.0.0' });
}

start().catch((err: unknown) => {
  fastify.log.error(err);
  process.exit(1);
});
