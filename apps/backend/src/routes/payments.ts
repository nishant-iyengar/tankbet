// @ts-nocheck — file kept but deactivated (charity/betting removed)
import type { FastifyInstance } from 'fastify';
import { prisma } from '../prisma';
import { requireAuth } from '../middleware/auth';
import { MIN_DEPOSIT_CENTS, WITHDRAWAL_FEE_CENTS } from '@tankbet/game-engine/constants';
import { requireStripe } from '../stripe';
import { env } from '../environment';

export async function paymentRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/payments/setup — Create Stripe Customer for user
  fastify.post('/setup', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.dbUser;

    if (user.stripeCustomerId) {
      return reply.send({ customerId: user.stripeCustomerId });
    }

    const customer = await requireStripe().customers.create({
      metadata: { userId: user.id, clerkId: user.clerkId },
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { stripeCustomerId: customer.id },
    });

    return reply.send({ customerId: customer.id });
  });

  // POST /api/payments/create-deposit — Create payment intent for deposit
  interface CreateDepositBody { amountCents: number }
  fastify.post<{ Body: CreateDepositBody }>('/create-deposit', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.dbUser;
    const body = req.body;

    if (!Number.isInteger(body.amountCents) || body.amountCents < MIN_DEPOSIT_CENTS) {
      return reply.status(400).send({ error: `Minimum deposit is ${MIN_DEPOSIT_CENTS} cents` });
    }

    if (!user.stripeCustomerId) {
      return reply.status(400).send({ error: 'Stripe customer not set up. Call /api/payments/setup first.' });
    }

    const paymentIntent = await requireStripe().paymentIntents.create({
      amount: body.amountCents,
      currency: 'usd',
      customer: user.stripeCustomerId,
      payment_method_types: ['us_bank_account'],
      metadata: { userId: user.id, amountCents: String(body.amountCents) },
    });

    return reply.send({ clientSecret: paymentIntent.client_secret });
  });

  // POST /api/payments/setup-bank — Create SetupIntent for ACH bank account collection
  fastify.post('/setup-bank', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.dbUser;

    // Ensure Stripe customer exists
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await requireStripe().customers.create({
        metadata: { userId: user.id, clerkId: user.clerkId },
      });
      customerId = customer.id;
      await prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId: customer.id },
      });
    }

    const setupIntent = await requireStripe().setupIntents.create({
      customer: customerId,
      payment_method_types: ['us_bank_account'],
    });

    return reply.send({
      clientSecret: setupIntent.client_secret,
      publishableKey: env.stripePublishableKey,
    });
  });

  // POST /api/payments/save-bank — Save payment method after Stripe.js bank collection.
  // Client sends the setupIntentId; backend verifies ownership via the setup intent's
  // customer field (avoids the pm.customer object-vs-string ambiguity).
  interface SaveBankBody { setupIntentId: string }
  fastify.post<{ Body: SaveBankBody }>('/save-bank', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body;

    // Re-read user to pick up stripeCustomerId that may have been created moments ago
    const freshUser = await prisma.user.findUnique({ where: { id: req.dbUser.id } });
    if (!freshUser) return reply.status(404).send({ error: 'User not found' });

    const si = await requireStripe().setupIntents.retrieve(body.setupIntentId);
    const siCustomerId = typeof si.customer === 'string' ? si.customer : si.customer?.id;

    if (!siCustomerId || siCustomerId !== freshUser.stripeCustomerId) {
      return reply.status(403).send({ error: 'Setup intent does not belong to your account' });
    }

    const paymentMethodId = typeof si.payment_method === 'string'
      ? si.payment_method
      : si.payment_method?.id;

    if (!paymentMethodId) {
      return reply.status(400).send({ error: 'No payment method on setup intent yet' });
    }

    await prisma.user.update({
      where: { id: freshUser.id },
      data: { stripePaymentMethodId: paymentMethodId },
    });

    return reply.send({ success: true });
  });

  // POST /api/payments/disconnect-bank — Remove connected bank account
  fastify.post('/disconnect-bank', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.dbUser;

    if (user.stripePaymentMethodId) {
      await requireStripe().paymentMethods.detach(user.stripePaymentMethodId);
      await prisma.user.update({
        where: { id: user.id },
        data: { stripePaymentMethodId: null },
      });
    }

    return reply.send({ success: true });
  });

  // POST /api/payments/withdraw — Request withdrawal
  interface WithdrawBody { amountCents: number }
  fastify.post<{ Body: WithdrawBody }>('/withdraw', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.dbUser;
    const body = req.body;

    if (!Number.isInteger(body.amountCents) || body.amountCents <= WITHDRAWAL_FEE_CENTS) {
      return reply.status(400).send({ error: 'Withdrawal amount must be greater than the processing fee' });
    }

    const availableBalance = user.balance - user.reservedBalance;
    if (body.amountCents > availableBalance) {
      return reply.status(400).send({ error: 'Insufficient balance' });
    }

    const netAmountCents = body.amountCents - WITHDRAWAL_FEE_CENTS;

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { balance: { decrement: body.amountCents } },
      });

      await tx.withdrawal.create({
        data: {
          userId: user.id,
          requestedAmountCents: body.amountCents,
          feeCents: WITHDRAWAL_FEE_CENTS,
          netAmountCents,
          status: 'PENDING',
        },
      });
    });

    return reply.send({ netAmountCents, feeCents: WITHDRAWAL_FEE_CENTS });
  });
}
