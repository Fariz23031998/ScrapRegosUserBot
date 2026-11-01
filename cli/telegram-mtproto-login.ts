import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { envPath } from '../src/paths';
import dotenv from 'dotenv';

'use strict';

dotenv.config({ path: envPath() });

function fail(message?: any) {
  console.error(message);
  process.exit(1);
}

function getCredentials() {
  const apiId = Number(process.env.TELEGRAM_API_ID?.trim());
  const apiHash = process.env.TELEGRAM_API_HASH?.trim() || '';
  if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
    fail('Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env (from https://my.telegram.org)');
  }
  return { apiId, apiHash };
}

async function main() {
  const { apiId, apiHash } = getCredentials();
  const rl = readline.createInterface({ input, output });

  try {
    const phone = (await rl.question('Phone number (E.164, e.g. +998901234567): ')).trim();
    if (!phone) {
      fail('Phone number is required');
    }

    const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
      connectionRetries: 5,
    });
    if (typeof client.setLogLevel === 'function') {
      client.setLogLevel('error' as import('telegram/extensions/Logger').LogLevel);
    }

    await client.start({
      phoneNumber: async () => phone,
      phoneCode: async () => (await rl.question('Login code from Telegram: ')).trim(),
      password: async () => (await rl.question('2FA password (if enabled): ')).trim(),
      onError: (err: Error) => console.error(err.message || String(err)),
    });

    const session = client.session.save();
    const me = await client.getMe();
    await client.disconnect();

    console.log('');
    console.log('Login OK.');
    if (me?.username) {
      console.log(`Account: @${me.username}`);
    } else if (me?.firstName) {
      console.log(`Account: ${me.firstName}${me.lastName ? ` ${me.lastName}` : ''}`);
    }
    console.log('');
    console.log('Add this to your project .env:');
    console.log(`TELEGRAM_MTPROTO_SESSION=${session}`);
    console.log('ENABLE_TELEGRAM_MTPROTO=1');
  } finally {
    rl.close();
  }
}

main().catch((err: Error) => {
  fail(err.message || String(err));
});
