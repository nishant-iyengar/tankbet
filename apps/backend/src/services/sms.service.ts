import twilio from 'twilio';

export async function sendSms(to: string, body: string): Promise<void> {
  const accountSid = process.env['TWILIO_ACCOUNT_SID'];
  const authToken = process.env['TWILIO_AUTH_TOKEN'];
  const fromNumber = process.env['TWILIO_PHONE_NUMBER'];

  if (!accountSid) {
    throw new Error('Missing env var: TWILIO_ACCOUNT_SID');
  }
  if (!authToken) {
    throw new Error('Missing env var: TWILIO_AUTH_TOKEN');
  }
  if (!fromNumber) {
    throw new Error('Missing env var: TWILIO_PHONE_NUMBER');
  }

  const client = twilio(accountSid, authToken);
  await client.messages.create({ to, from: fromNumber, body });
}
