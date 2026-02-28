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
import { scheduleTaxReminderJob } from './jobs/taxReminder';
import { startInviteExpiryJob } from './services/game.service';

const fastify = Fastify({ logger: true });

async function start(): Promise<void> {
  await fastify.register(cors, {
    origin: process.env['FRONTEND_URL'] ?? 'http://localhost:5173',
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await fastify.register(clerkPlugin, {
    publishableKey: process.env['CLERK_PUBLISHABLE_KEY'] ?? '',
    secretKey: process.env['CLERK_SECRET_KEY'] ?? '',
  });

  // Route registration
  await fastify.register(userRoutes, { prefix: '/api/users' });
  await fastify.register(charityRoutes, { prefix: '/api/charities' });
  await fastify.register(gameRoutes, { prefix: '/api/games' });
  await fastify.register(paymentRoutes, { prefix: '/api/payments' });
  await fastify.register(webhookRoutes, { prefix: '/api/webhooks' });

  if (process.env['NODE_ENV'] !== 'production') {
    const { devRoutes } = await import('./routes/dev');
    await fastify.register(devRoutes, { prefix: '/api/dev' });
  }

  scheduleTaxReminderJob();
  startInviteExpiryJob();

  const port = Number(process.env['PORT'] ?? 3001);

  // Attach Colyseus to the same HTTP server as Fastify
  const gameServer = new Server({ transport: new WebSocketTransport({ server: fastify.server }) });
  gameServer.define('tank', TankRoom);

  await fastify.listen({ port, host: '0.0.0.0' });
}

start().catch((err: unknown) => {
  fastify.log.error(err);
  process.exit(1);
});
