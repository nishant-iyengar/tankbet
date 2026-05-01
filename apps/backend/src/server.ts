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
import { isDraining, setDraining } from './drain';

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

  // Health check — returns 503 while draining so Fly stops routing new traffic here
  fastify.get('/health', async (_req, reply) => {
    if (isDraining()) return reply.status(503).send({ status: 'draining' });
    return reply.send({ status: 'ok' });
  });

  // Route registration
  await fastify.register(userRoutes, { prefix: '/api/users' });
  await fastify.register(gameRoutes, { prefix: '/api/games' });
  await fastify.register(practiceRoutes, { prefix: '/api/practice' });
  await fastify.register(statsRoutes, { prefix: '/api/stats' });

  if (isDev) {
    const { devRoutes } = await import('./routes/dev');
    await fastify.register(devRoutes, { prefix: '/api/dev' });
  }

  startGameCleanupJobs();

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

// Max time to wait for active rooms to drain before forcing shutdown (must be
// less than fly.toml kill_timeout so we exit cleanly before SIGKILL arrives).
const MAX_DRAIN_MS = 4.5 * 60 * 1000; // 4.5 minutes

async function shutdown(): Promise<void> {
  if (isDraining()) return; // guard against double-signal
  setDraining();
  logger.info('SIGTERM received — draining active rooms before shutdown');

  const deadline = Date.now() + MAX_DRAIN_MS;

  while (Date.now() < deadline) {
    const rooms = await matchMaker.query({});
    if (rooms.length === 0) break;
    logger.info({ activeRooms: rooms.length }, 'Waiting for rooms to finish');
    await new Promise<void>((resolve) => { setTimeout(resolve, 3000); });
  }

  const remaining = await matchMaker.query({});
  if (remaining.length > 0) {
    logger.warn({ activeRooms: remaining.length }, 'Drain timeout reached — forcing shutdown with active rooms');
  } else {
    logger.info('All rooms finished — shutting down cleanly');
  }

  process.exit(0);
}

start()
  .then(() => {
    process.on('SIGTERM', () => { void shutdown(); });
    process.on('SIGINT',  () => { void shutdown(); });
  })
  .catch((err: unknown) => {
    logger.error(err);
    process.exit(1);
  });
