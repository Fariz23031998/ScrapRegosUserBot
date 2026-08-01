'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  HELLO_SENTENCES,
  formatPhoneForTelegram,
  isTelegramMtprotoConfigured,
  isTelegramMtprotoEnabled,
  pickRandomHello,
  sendTelegramByPhone,
} = require('../src/telegram-mtproto/client');

const MTPROTO_ENV = [
  'ENABLE_TELEGRAM_MTPROTO',
  'TELEGRAM_API_ID',
  'TELEGRAM_API_HASH',
  'TELEGRAM_MTPROTO_SESSION',
];

describe('Telegram MTProto client helpers', () => {
  let previousEnv;

  before(() => {
    previousEnv = Object.fromEntries(MTPROTO_ENV.map((key) => [key, process.env[key]]));
  });

  after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    for (const key of MTPROTO_ENV) delete process.env[key];
  });

  it('formats Uzbekistan phones as E.164 for Telegram', () => {
    assert.equal(formatPhoneForTelegram('+998 90 111 22 33'), '+998901112233');
    assert.equal(formatPhoneForTelegram('901112233'), '+998901112233');
    assert.equal(formatPhoneForTelegram('not-a-phone'), null);
  });

  it('requires enable flag and full credentials', () => {
    process.env.ENABLE_TELEGRAM_MTPROTO = '1';
    process.env.TELEGRAM_API_ID = '12345';
    process.env.TELEGRAM_API_HASH = 'hash';
    assert.equal(isTelegramMtprotoConfigured(), false);
    assert.equal(isTelegramMtprotoEnabled(), false);

    process.env.TELEGRAM_MTPROTO_SESSION = 'session';
    assert.equal(isTelegramMtprotoConfigured(), true);
    assert.equal(isTelegramMtprotoEnabled(), true);

    process.env.ENABLE_TELEGRAM_MTPROTO = '0';
    assert.equal(isTelegramMtprotoEnabled(), false);
  });

  it('sends after resolving the phone via injected client hooks', async () => {
    const sent = [];
    const fakeUser = { id: 42, accessHash: 99 };

    const result = await sendTelegramByPhone(
      { phone: '998901112233', text: 'Pay here' },
      {
        getClientFn: async () => ({
          sendMessage: async (peer, options) => {
            sent.push({ peer, options });
          },
        }),
        resolveUserByPhoneFn: async () => ({
          user: fakeUser,
          method: 'resolve_phone',
        }),
      }
    );

    assert.deepEqual(result, {
      sent: true,
      recipient: '+998901112233',
      userId: '42',
      method: 'resolve_phone',
    });
    assert.equal(sent.length, 1);
    assert.equal(String(sent[0].peer.userId), '42');
    assert.equal(String(sent[0].peer.accessHash), '99');
    assert.deepEqual(sent[0].options, { message: 'Pay here' });
  });

  it('pickRandomHello returns one of the ten Russian greetings', () => {
    assert.equal(HELLO_SENTENCES.length, 10);
    for (let i = 0; i < 20; i += 1) {
      assert.equal(HELLO_SENTENCES.includes(pickRandomHello()), true);
    }
  });

  it('sends a random greeting then the payment text when withGreeting is true', async () => {
    const sent = [];
    const delays = [];
    const fakeUser = { id: 42, accessHash: 99 };
    const greeting = 'Добрый день!';

    const result = await sendTelegramByPhone(
      { phone: '998901112233', text: 'Pay here', withGreeting: true },
      {
        getClientFn: async () => ({
          sendMessage: async (_peer, options) => {
            sent.push({ options });
          },
        }),
        resolveUserByPhoneFn: async () => ({
          user: fakeUser,
          method: 'resolve_phone',
        }),
        pickRandomHelloFn: () => greeting,
        delayFn: async (ms) => {
          delays.push(ms);
        },
      }
    );

    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0].options, { message: greeting });
    assert.deepEqual(sent[1].options, { message: 'Pay here' });
    assert.deepEqual(delays, [1500]);
    assert.equal(result.greeting, greeting);
    assert.equal(result.sent, true);
  });

  it('rejects invalid phone and empty text', async () => {
    await assert.rejects(
      () =>
        sendTelegramByPhone(
          { phone: 'bad', text: 'x' },
          { getClientFn: async () => ({}) }
        ),
      /Invalid Telegram recipient phone/
    );
    await assert.rejects(
      () =>
        sendTelegramByPhone(
          { phone: '998901112233', text: '   ' },
          { getClientFn: async () => ({}) }
        ),
      /Message text is required/
    );
  });
});
