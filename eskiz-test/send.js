'use strict';

const { BASE_URL, fail, login } = require('./lib/client');

const FROM = process.env.ESKIZ_FROM?.trim() || '4546';
const PHONE = process.env.ESKIZ_PHONE;
const TEXT = process.env.ESKIZ_TEXT;

if (!PHONE || !TEXT) {
  fail('Set ESKIZ_PHONE and ESKIZ_TEXT in .env');
}

const phone = String(PHONE).replace(/^\+/, '').replace(/\s+/g, '');
if (!/^\d{12}$/.test(phone)) {
  fail(`ESKIZ_PHONE must be digits without +, e.g. 998901234567 (got: ${PHONE})`);
}

async function main() {
  console.log(`Base: ${BASE_URL}`);
  console.log(`To: ${phone}`);
  console.log(`From: ${FROM}`);
  console.log(`Text: ${TEXT}`);
  console.log('');

  const token = await login();
  console.log('Logged in');

  const form = new FormData();
  form.append('mobile_phone', phone);
  form.append('message', TEXT);
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

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('Send response is not JSON');
  }

  if (!res.ok || parsed?.id == null) {
    fail(parsed?.message || parsed?.error || 'Send failed');
  }

  console.log(`request_id: ${parsed.id}`);
}

main().catch((err) => {
  fail(err.message || String(err));
});
