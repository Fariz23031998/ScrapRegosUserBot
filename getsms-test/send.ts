import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '.env') });

const LOGIN = process.env.GETSMS_LOGIN;
const PASSWORD = process.env.GETSMS_PASSWORD;
const NICKNAME = process.env.GETSMS_NICKNAME;
const PHONE = process.env.GETSMS_PHONE;
const TEXT = process.env.GETSMS_TEXT;
const GATEWAY_URL = process.env.GETSMS_URL || 'http://185.8.212.184/smsgateway/';

type GatewayItem = {
  error?: string;
  error_no?: string | number;
  error_text?: string;
  text?: string;
  request_id?: string | number;
  message_id?: string | number;
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!LOGIN || !PASSWORD) {
  fail('Set GETSMS_LOGIN and GETSMS_PASSWORD in .env');
}
if (!PHONE || !TEXT) {
  fail('Set GETSMS_PHONE and GETSMS_TEXT in .env');
}

const phone = String(PHONE).replace(/^\+/, '').replace(/\s+/g, '');
if (!/^\d{12}$/.test(phone)) {
  fail(`GETSMS_PHONE must be digits without +, e.g. 998901234567 (got: ${PHONE})`);
}

const params = new URLSearchParams();
params.set('login', LOGIN);
params.set('password', PASSWORD);
if (NICKNAME && NICKNAME.trim()) {
  params.set('nickname', NICKNAME.trim());
}
params.set('data', JSON.stringify([{ phone, text: TEXT }]));

async function main(): Promise<void> {
  console.log(`POST ${GATEWAY_URL}`);
  console.log(`To: ${phone}`);
  console.log(`Text: ${TEXT}`);
  if (NICKNAME && NICKNAME.trim()) {
    console.log(`Nickname: ${NICKNAME.trim()}`);
  }
  console.log('');

  const res = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'getsms-test/1.0',
    },
    body: params.toString(),
  });

  const raw = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(raw);
  console.log('');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    fail('Response is not JSON');
  }

  const items: GatewayItem[] = Array.isArray(parsed) ? (parsed as GatewayItem[]) : [parsed as GatewayItem];
  let hasError = !res.ok;

  for (const item of items) {
    if (item.error || item.error_no) {
      hasError = true;
      console.error(`Error ${item.error_no ?? '?'}: ${item.error_text || item.text || 'unknown'}`);
    } else if (item.request_id != null) {
      console.log(`request_id: ${item.request_id}`);
      if (item.message_id != null) {
        console.log(`message_id: ${item.message_id}`);
      }
    }
  }

  if (hasError) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  fail(message);
});
