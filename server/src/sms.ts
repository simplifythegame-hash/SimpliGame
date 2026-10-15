import https from 'https';

// Twilio SMS sender + log-only fallback.
//
// Real sending posts to Twilio's Messages API with Basic auth from
// TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER. If ANY of
// the three is missing, the app runs in LOG-ONLY mode: sendSms returns
// { mode: 'logged' } without making an HTTP call, and the caller records
// the attempt as 'logged' — never claiming it was sent.
//
// Note: Twilio trial accounts can only text numbers verified in the
// Twilio console. Verify family numbers there during the trial, or use
// a paid number for full sending.

export type SmsSendResult =
  | { mode: 'sent'; sid: string }
  | { mode: 'logged' }
  | { mode: 'failed'; error: string };

export function isSmsConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_FROM_NUMBER,
  );
}

export function sendSms(to: string, body: string): Promise<SmsSendResult> {
  if (!isSmsConfigured()) return Promise.resolve({ mode: 'logged' });
  const sid = process.env.TWILIO_ACCOUNT_SID as string;
  const token = process.env.TWILIO_AUTH_TOKEN as string;
  const from = process.env.TWILIO_FROM_NUMBER as string;
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  return new Promise((resolve) => {
    const req = https.request(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(params.toString()),
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data) as { sid?: string };
              resolve({ mode: 'sent', sid: parsed.sid ?? '' });
            } catch {
              resolve({ mode: 'sent', sid: '' });
            }
          } else {
            let message = `Twilio rejected the message (HTTP ${res.statusCode}).`;
            try {
              const parsed = JSON.parse(data) as { message?: string };
              if (parsed.message) message = parsed.message;
            } catch {
              // Keep the default message.
            }
            resolve({ mode: 'failed', error: message });
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('Twilio request timed out.'));
    });
    req.on('error', (err) => {
      resolve({ mode: 'failed', error: err.message });
    });
    req.write(params.toString());
    req.end();
  });
}
