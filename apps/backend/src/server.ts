import Fastify from 'fastify';
import cors from '@fastify/cors';
import { clerkPlugin } from '@clerk/fastify';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { userRoutes } from './routes/users';
import { charityRoutes } from './routes/charities';
import { gameRoutes } from './routes/games';
import { paymentRoutes } from './routes/payments';
import { webhookRoutes } from './routes/webhooks';
import { TankRoom } from './rooms/TankRoom';
import { PracticeRoom } from './rooms/PracticeRoom';
import { practiceRoutes } from './routes/practice';
import { scheduleTaxReminderJob } from './jobs/taxReminder';
import { scheduleDonationSummaryJob } from './jobs/donationSummary';
import { startInviteExpiryJob } from './services/game.service';
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
  await fastify.register(charityRoutes, { prefix: '/api/charities' });
  await fastify.register(gameRoutes, { prefix: '/api/games' });
  await fastify.register(paymentRoutes, { prefix: '/api/payments' });
  await fastify.register(webhookRoutes, { prefix: '/api/webhooks' });
  await fastify.register(practiceRoutes, { prefix: '/api/practice' });

  if (isDev) {
    const { devRoutes } = await import('./routes/dev');
    await fastify.register(devRoutes, { prefix: '/api/dev' });
  }

  scheduleTaxReminderJob();
  scheduleDonationSummaryJob();
  startInviteExpiryJob();

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
