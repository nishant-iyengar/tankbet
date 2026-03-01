import Stripe from 'stripe';
import { env } from './environment';

export const stripe = env.stripeSecretKey
  ? new Stripe(env.stripeSecretKey, { apiVersion: '2025-02-24.acacia' })
  : null;

export function requireStripe(): Stripe {
  if (!stripe) throw new Error('Stripe is not configured');
  return stripe;
}
