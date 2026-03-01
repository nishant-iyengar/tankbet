import twilio from 'twilio';
import { env } from '../environment';

export async function sendSms(to: string, body: string): Promise<void> {
  if (!env.twilioAccountSid) throw new Error('Missing env var: TWILIO_ACCOUNT_SID');
  if (!env.twilioAuthToken) throw new Error('Missing env var: TWILIO_AUTH_TOKEN');
  if (!env.twilioPhoneNumber) throw new Error('Missing env var: TWILIO_PHONE_NUMBER');

  const client = twilio(env.twilioAccountSid, env.twilioAuthToken);
  await client.messages.create({ to, from: env.twilioPhoneNumber, body });
}
