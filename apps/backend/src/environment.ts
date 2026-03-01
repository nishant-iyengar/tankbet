function require(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const env = {
  nodeEnv:             optional('NODE_ENV', 'development'),
  port:                Number(optional('PORT', '3001')),
  frontendUrl:         optional('FRONTEND_URL', 'http://localhost:5173'),
  databaseUrl:         require('DATABASE_URL'),
  clerkPublishableKey: optional('CLERK_PUBLISHABLE_KEY', ''),
  clerkSecretKey:      optional('CLERK_SECRET_KEY', ''),
  stripeSecretKey:     require('STRIPE_SECRET_KEY'),
  stripeWebhookSecret: require('STRIPE_WEBHOOK_SECRET'),
  stripePublishableKey:optional('STRIPE_PUBLISHABLE_KEY', ''),
  twilioAccountSid:    optional('TWILIO_ACCOUNT_SID', ''),
  twilioAuthToken:     optional('TWILIO_AUTH_TOKEN', ''),
  twilioPhoneNumber:   optional('TWILIO_PHONE_NUMBER', ''),
  pledgeApiKey:        optional('PLEDGE_API_KEY', ''),
  betaMode:            optional('BETA_MODE', 'false') === 'true',
} as const;

export const isDev = env.nodeEnv !== 'production';
export const isBeta = env.betaMode;
