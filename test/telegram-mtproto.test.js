'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_HELLO_SENTENCES,
  HELLO_SENTENCES,
  formatPhoneForTelegram,
  getHelloSentences,
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
  'HELLO_SENTENCES',
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
    assert.deepEqual(sent[0].options, { message: 'Pay here', parseMode: 'html' });
  });

  it('pickRandomHello returns one of the default Russian greetings', () => {
    assert.equal(DEFAULT_HELLO_SENTENCES.length, 10);
    assert.deepEqual(HELLO_SENTENCES, DEFAULT_HELLO_SENTENCES);
    assert.deepEqual(getHelloSentences(), [...DEFAULT_HELLO_SENTENCES]);
    for (let i = 0; i < 20; i += 1) {
      assert.equal(DEFAULT_HELLO_SENTENCES.includes(pickRandomHello()), true);
    }
  });

  it('reads HELLO_SENTENCES from env when set (one greeting per line)', () => {
    process.env.HELLO_SENTENCES = 'Привет!\n\n Добрый вечер! \n';
    assert.deepEqual(getHelloSentences(), ['Привет!', 'Добрый вечер!']);
    for (let i = 0; i < 10; i += 1) {
      assert.equal(['Привет!', 'Добрый вечер!'].includes(pickRandomHello()), true);
    }

    process.env.HELLO_SENTENCES = '   \n  ';
    assert.deepEqual(getHelloSentences(), [...DEFAULT_HELLO_SENTENCES]);
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
    assert.deepEqual(sent[0].options, { message: greeting, parseMode: false });
    assert.deepEqual(sent[1].options, { message: 'Pay here', parseMode: 'html' });
    assert.deepEqual(delays, [1500]);
    assert.equal(result.greeting, greeting);
    assert.equal(result.sent, true);
  });

  it('allows disabling HTML parse mode for the payment text', async () => {
    const sent = [];
    await sendTelegramByPhone(
      { phone: '998901112233', text: 'plain <b>text</b>', parseMode: false },
      {
        getClientFn: async () => ({
          sendMessage: async (_peer, options) => {
            sent.push(options);
          },
        }),
        resolveUserByPhoneFn: async () => ({
          user: { id: 1, accessHash: 2 },
          method: 'resolve_phone',
        }),
      }
    );
    assert.deepEqual(sent[0], { message: 'plain <b>text</b>', parseMode: false });
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
