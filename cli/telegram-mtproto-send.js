'use strict';

const { envPath } = require('../src/paths');
require('dotenv').config({ path: envPath() });

const {
  isTelegramMtprotoConfigured,
  sendTelegramByPhone,
  resetClient,
} = require('../src/telegram-mtproto/client');

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  const phone = process.env.TELEGRAM_MTPROTO_PHONE?.trim() || process.argv[2]?.trim();
  const text =
    process.env.TELEGRAM_MTPROTO_TEXT?.trim() ||
    process.argv.slice(3).join(' ').trim() ||
    'Test message from ScrapRegosUserBot MTProto notifier';

  if (!isTelegramMtprotoConfigured()) {
    fail(
      'Set TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_MTPROTO_SESSION in .env (run npm run telegram:login)'
    );
  }
  if (!phone) {
    fail('Usage: npm run telegram:send -- +998901234567 "Your message"');
  }

  console.log(`Sending to ${phone}…`);
  try {
    const result = await sendTelegramByPhone({ phone, text });
    console.log('Sent.');
    console.log(`recipient: ${result.recipient}`);
    console.log(`userId: ${result.userId}`);
    console.log(`method: ${result.method}`);
  } finally {
    await resetClient();
  }
}

main().catch((err) => {
  fail(err.message || String(err));
});
