// External API: Resend (https://resend.com) sends the notification e-mails.
// The API key is read from AWS Secrets Manager (roadhub/resend), never from code or Git.
// It never throws: the result says what happened, and the caller records it.
const { secrets } = require('../shared');
const config = require('../config');

const TIMEOUT_MS = 5000;

async function sendEmail({ to, subject, text, idempotencyKey }) {
  const { RESEND_API_KEY, RESEND_FROM } = await secrets.getSecret(config.resendSecretName);
  if (!RESEND_API_KEY || RESEND_API_KEY === 'not-set') {
    return { status: 'skipped', errorCode: 'NO_API_KEY' }; // local setup without a key: nothing is sent
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${config.resendApiUrl}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        // Same key = same e-mail: if the worker repeats a send, Resend does not send it twice.
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, text }),
      signal: controller.signal
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      return { status: 'sent', providerMessageId: data.id };
    }
    return { status: 'failed', errorCode: `RESEND_${res.status}` };
  } catch (e) {
    return { status: 'failed', errorCode: e.name === 'AbortError' ? 'RESEND_TIMEOUT' : 'RESEND_UNREACHABLE' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendEmail };
