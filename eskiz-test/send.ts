import { BASE_URL, fail, login } from './lib/client';

const FROM = process.env.ESKIZ_FROM?.trim() || '4546';
const PHONE = process.env.ESKIZ_PHONE;
const TEXT = process.env.ESKIZ_TEXT;

if (!PHONE || !TEXT) {
  fail('Set ESKIZ_PHONE and ESKIZ_TEXT in .env');
}

const phone = String(PHONE).replace(/^\+/, '').replace(/\s+/g, '');
const messageText: string = TEXT;
if (!/^\d{12}$/.test(phone)) {
  fail(`ESKIZ_PHONE must be digits without +, e.g. 998901234567 (got: ${PHONE})`);
}

type SendResponse = {
  id?: string | number;
  message?: string;
  error?: string;
};

async function main(): Promise<void> {
  console.log(`Base: ${BASE_URL}`);
  console.log(`To: ${phone}`);
  console.log(`From: ${FROM}`);
  console.log(`Text: ${messageText}`);
  console.log('');

  const token = await login();
  console.log('Logged in');

  const form = new FormData();
  form.append('mobile_phone', phone);
  form.append('message', messageText);
  form.append('from', FROM);

  const res = await fetch(`${BASE_URL}/api/message/sms/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'eskiz-test/1.0',
    },
    body: form,
  });

  const raw = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(raw);
  console.log('');

  let parsed: SendResponse;
  try {
    parsed = JSON.parse(raw) as SendResponse;
  } catch {
    fail('Send response is not JSON');
  }

  if (!res.ok || parsed?.id == null) {
    fail(parsed?.message || parsed?.error || 'Send failed');
  }

  console.log(`request_id: ${parsed.id}`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  fail(message);
});
