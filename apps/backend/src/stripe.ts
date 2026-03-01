import Stripe from 'stripe';
import { env } from './environment';

export const stripe = new Stripe(env.stripeSecretKey, {
  apiVersion: '2025-02-24.acacia',
});
