import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { requireStripe } from '../stripe';
import { prisma } from '../prisma';
import { env } from '../environment';

export async function webhookRoutes(fastify: FastifyInstance): Promise<void> {
  // Disable body parsing for webhook route — Stripe needs raw body
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      done(null, body);
    },
  );

  // POST /api/webhooks/stripe
  fastify.post('/stripe', async (req, reply) => {
    const sig = req.headers['stripe-signature'];
    if (!sig || typeof sig !== 'string') {
      return reply.status(400).send({ error: 'Missing stripe-signature header' });
    }

    const webhookSecret = env.stripeWebhookSecret;

    let event: Stripe.Event;
    try {
      event = requireStripe().webhooks.constructEvent(req.body as Buffer, sig, webhookSecret);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      fastify.log.error(`Webhook signature verification failed: ${message}`);
      return reply.status(400).send({ error: 'Invalid signature' });
    }

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const userId = pi.metadata['userId'];
        const amountCents = Number(pi.metadata['amountCents']);

        if (!userId || !amountCents) {
          fastify.log.error('Missing metadata on payment_intent.succeeded');
          break;
        }

        // Calculate Stripe fees (approximate for ACH: 0.8%, max $5)
        const stripeFeesCents = Math.min(Math.round(amountCents * 0.008), 500);

        await prisma.$transaction([
          prisma.deposit.create({
            data: {
              userId,
              amountCents,
              stripeFeesCents,
              stripePaymentIntentId: pi.id,
              status: 'SUCCEEDED',
            },
          }),
          prisma.user.update({
            where: { id: userId },
            data: { balance: { increment: amountCents } },
          }),
        ]);

        fastify.log.info(`Deposit of ${amountCents} cents for user ${userId} succeeded`);
        break;
      }

      case 'charge.dispute.created': {
        const dispute = event.data.object;
        fastify.log.error(`[DISPUTE] Manual review required: ${dispute.id}`);
        break;
      }

      default:
        fastify.log.info(`Unhandled webhook event: ${event.type}`);
    }

    return reply.send({ received: true });
  });
}
