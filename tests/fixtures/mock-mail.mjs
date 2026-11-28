// Loaded only by the isolated password-reset tests. Never sends real email.
import { appendFileSync } from 'node:fs';
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url) === 'https://api.resend.com/emails') {
    appendFileSync(process.env.PULSE_TEST_MAIL, `${options.body}\n`);
    return new Response('{"id":"test-mail"}', { status: 200 });
  }
  return originalFetch(url, options);
};
