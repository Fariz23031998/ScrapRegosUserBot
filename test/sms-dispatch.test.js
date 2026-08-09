const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_GETSMS_MESSAGE_TEMPLATE,
  DEFAULT_PAYMENT_MESSAGE_TEMPLATE,
  PAYMENT_MESSAGE_CHANNELS,
  formatGetSmsPaymentMessage,
  formatPaymentMessage,
  renderSmsTemplate,
  resolvePaymentMessageTemplate,
} = require('../src/sms/sms-message');
const { isGetSmsEnabled, sendGetSms } = require('../src/sms/getsms-client');
const { enqueueOrderPaymentSms } = require('../src/sms/sms-queue');

const SMS_ENV = [
  'ENABLE_GETSMS',
  'GETSMS_LOGIN',
  'GETSMS_PASSWORD',
  'GETSMS_NICKNAME',
  'GETSMS_URL',
  'GETSMS_MESSAGE_TEMPLATE',
  'SMS_GATEWAY_MESSAGE_TEMPLATE',
  'TELEGRAM_MTPROTO_MESSAGE_TEMPLATE',
  'SMS_GATEWAY_ENABLED',
  'REDIS_URL',
  'TELEGRAM_BOT_USERNAME',
  'SMS_SUPPORT_TELEGRAM_URL',
  'SMS_WEBSITE_URL',
  'SMS_SUPPORT_PHONE',
  'ENABLE_TELEGRAM_MTPROTO',
  'TELEGRAM_API_ID',
  'TELEGRAM_API_HASH',
  'TELEGRAM_MTPROTO_SESSION',
];
const order = {
  id: 'order-1',
  telegram_id: 123,
  bot_user_phone: '+998901000000',
  client_phone: '+998901112233',
  amount: 50000,
  currency: 'UZS',
};
const paymentPageUrl = 'https://example.test/pay/order-1';

describe('SMS templates', () => {
  let previousEnv;

  before(() => {
    previousEnv = Object.fromEntries(SMS_ENV.map((key) => [key, process.env[key]]));
  });

  after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    for (const key of SMS_ENV) delete process.env[key];
  });

  it('renders known placeholders and leaves unknown placeholders intact', () => {
    assert.equal(
      renderSmsTemplate('{known}/{missing}/{unknown}', { known: 'yes', missing: null }),
      'yes//{unknown}'
    );
  });

  it('renders the multiline GETSMS default with a formatted amount and footer', () => {
    const message = formatGetSmsPaymentMessage(order, paymentPageUrl);
    assert.equal(
      message,
      DEFAULT_GETSMS_MESSAGE_TEMPLATE.replace('{amount}', '50 000')
        .replace('{currency}', 'UZS')
        .replace('{payment_page_url}', paymentPageUrl)
        .replace('{support_telegram_url}', 'https://t.me/EasyTradesupport_bot')
        .replace('{website_url}', 'https://rofeev.uz')
        .replace('{support_phone}', '+998 55 705-00-30')
    );
    assert.match(message, /\nОплатить:/);
  });

  it('supports overriding the GETSMS multiline template', () => {
    process.env.GETSMS_MESSAGE_TEMPLATE = '{amount}|{currency}|{payment_page_url}';
    assert.equal(
      formatGetSmsPaymentMessage(order, paymentPageUrl),
      `50 000|UZS|${paymentPageUrl}`
    );
  });

  it('uses a separate template per notification channel', () => {
    process.env.GETSMS_MESSAGE_TEMPLATE = 'GETSMS:{amount}';
    process.env.SMS_GATEWAY_MESSAGE_TEMPLATE = 'GATEWAY:{amount}';
    process.env.TELEGRAM_MTPROTO_MESSAGE_TEMPLATE = 'MTPROTO:{amount}';

    assert.equal(
      formatPaymentMessage(order, paymentPageUrl, PAYMENT_MESSAGE_CHANNELS.GETSMS),
      'GETSMS:50 000'
    );
    assert.equal(
      formatPaymentMessage(order, paymentPageUrl, PAYMENT_MESSAGE_CHANNELS.SMS_GATEWAY),
      'GATEWAY:50 000'
    );
    assert.equal(
      formatPaymentMessage(order, paymentPageUrl, PAYMENT_MESSAGE_CHANNELS.MTPROTO),
      'MTPROTO:50 000'
    );
  });

  it('escapes dynamic MTProto placeholders for HTML parse mode', () => {
    const url = 'https://example.test/pay?order_id=1&x=<y>';
    process.env.TELEGRAM_MTPROTO_MESSAGE_TEMPLATE =
      '<b>Оплата</b>\n<a href="{payment_page_url}">Оплатить</a>';
    assert.equal(
      formatPaymentMessage(order, url, PAYMENT_MESSAGE_CHANNELS.MTPROTO),
      '<b>Оплата</b>\n<a href="https://example.test/pay?order_id=1&amp;x=&lt;y&gt;">Оплатить</a>'
    );
    assert.equal(
      formatPaymentMessage(order, url, PAYMENT_MESSAGE_CHANNELS.GETSMS),
      DEFAULT_PAYMENT_MESSAGE_TEMPLATE.replace('{amount}', '50 000')
        .replace('{currency}', 'UZS')
        .replace('{payment_page_url}', url)
        .replace('{support_telegram_url}', 'https://t.me/EasyTradesupport_bot')
        .replace('{website_url}', 'https://rofeev.uz')
        .replace('{support_phone}', '+998 55 705-00-30')
    );
  });

  it('falls back SMS gateway and MTProto to GETSMS_MESSAGE_TEMPLATE when unset', () => {
    process.env.GETSMS_MESSAGE_TEMPLATE = 'SHARED:{amount}';

    assert.equal(
      resolvePaymentMessageTemplate(PAYMENT_MESSAGE_CHANNELS.SMS_GATEWAY),
      'SHARED:{amount}'
    );
    assert.equal(
      resolvePaymentMessageTemplate(PAYMENT_MESSAGE_CHANNELS.MTPROTO),
      'SHARED:{amount}'
    );
    assert.equal(
      formatPaymentMessage(order, paymentPageUrl, PAYMENT_MESSAGE_CHANNELS.SMS_GATEWAY),
      'SHARED:50 000'
    );
  });

  it('uses the built-in default when no channel or shared template is set', () => {
    assert.equal(
      resolvePaymentMessageTemplate(PAYMENT_MESSAGE_CHANNELS.GETSMS),
      DEFAULT_PAYMENT_MESSAGE_TEMPLATE
    );
    assert.equal(
      resolvePaymentMessageTemplate(PAYMENT_MESSAGE_CHANNELS.SMS_GATEWAY),
      DEFAULT_PAYMENT_MESSAGE_TEMPLATE
    );
    assert.equal(
      resolvePaymentMessageTemplate(PAYMENT_MESSAGE_CHANNELS.MTPROTO),
      DEFAULT_PAYMENT_MESSAGE_TEMPLATE
    );
  });
});

describe('GETSMS client', () => {
  let previousEnv;

  before(() => {
    previousEnv = Object.fromEntries(SMS_ENV.map((key) => [key, process.env[key]]));
  });

  after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    for (const key of SMS_ENV) delete process.env[key];
  });

  it('requires the enable flag and nonblank credentials', () => {
    process.env.ENABLE_GETSMS = '0';
    process.env.GETSMS_LOGIN = 'login';
    process.env.GETSMS_PASSWORD = 'password';
    assert.equal(isGetSmsEnabled(), false);

    process.env.ENABLE_GETSMS = '1';
    process.env.GETSMS_PASSWORD = ' ';
    assert.equal(isGetSmsEnabled(), false);

    process.env.GETSMS_PASSWORD = 'password';
    assert.equal(isGetSmsEnabled(), true);
  });

  it('posts a form request and returns request_id', async () => {
    process.env.GETSMS_LOGIN = 'login';
    process.env.GETSMS_PASSWORD = 'password';
    process.env.GETSMS_NICKNAME = 'ROFEEV';
    process.env.GETSMS_URL = 'https://getsms.test/send';
    let request;

    const result = await sendGetSms(
      { phone: '+998 90 111 22 33', text: 'Test' },
      {
        fetchImpl: async (url, options) => {
          request = { url, options };
          return {
            ok: true,
            status: 200,
            text: async () => '[{"request_id":52480252,"message_id":16854781}]',
          };
        },
      }
    );

    assert.deepEqual(result, {
      requestId: 52480252,
      messageId: 16854781,
      recipient: '998901112233',
    });
    assert.equal(request.url, 'https://getsms.test/send');
    const form = new URLSearchParams(request.options.body);
    assert.equal(form.get('login'), 'login');
    assert.equal(form.get('nickname'), 'ROFEEV');
    assert.deepEqual(JSON.parse(form.get('data')), [
      { phone: '998901112233', text: 'Test' },
    ]);
  });
});

describe('order SMS dispatch', () => {
  let previousEnv;
  let sent;
  let queued;
  let mtprotoSent;
  let logs;

  before(() => {
    previousEnv = Object.fromEntries(SMS_ENV.map((key) => [key, process.env[key]]));
  });

  after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    for (const key of SMS_ENV) delete process.env[key];
    sent = [];
    queued = [];
    mtprotoSent = [];
    logs = [];
  });

  function dependencies({ getsmsError, gatewayError, mtprotoError } = {}) {
    return {
      sendGetSmsFn: async (payload) => {
        sent.push(payload);
        if (getsmsError) throw new Error(getsmsError);
        return { requestId: 'request-1', messageId: 'message-1' };
      },
      enqueueSmsJobFn: async (job) => {
        queued.push(job);
        if (gatewayError) throw new Error(gatewayError);
        return job;
      },
      sendTelegramByPhoneFn: async (payload) => {
        mtprotoSent.push(payload);
        if (mtprotoError) throw new Error(mtprotoError);
        return {
          sent: true,
          recipient: `+${payload.phone}`,
          userId: '42',
          method: 'resolve_phone',
        };
      },
      logOrderEventFn: (_db, event) => logs.push(event.action),
    };
  }

  function enableGetSms() {
    process.env.ENABLE_GETSMS = '1';
    process.env.GETSMS_LOGIN = 'login';
    process.env.GETSMS_PASSWORD = 'password';
  }

  function enableGateway() {
    process.env.SMS_GATEWAY_ENABLED = '1';
    process.env.REDIS_URL = 'redis://example.test:6379';
  }

  function enableMtproto() {
    process.env.ENABLE_TELEGRAM_MTPROTO = '1';
    process.env.TELEGRAM_API_ID = '12345';
    process.env.TELEGRAM_API_HASH = 'hash';
    process.env.TELEGRAM_MTPROTO_SESSION = 'session';
  }

  it('dispatches through GETSMS only', async () => {
    enableGetSms();
    process.env.SMS_GATEWAY_ENABLED = '0';

    const result = await enqueueOrderPaymentSms(
      null,
      order,
      paymentPageUrl,
      dependencies()
    );

    assert.equal(sent.length, 1);
    assert.equal(queued.length, 0);
    assert.equal(mtprotoSent.length, 0);
    assert.equal(result.getsms.sent, true);
    assert.deepEqual(result.gateway, { skipped: true, reason: 'disabled' });
    assert.deepEqual(result.mtproto, { skipped: true, reason: 'disabled' });
    assert.deepEqual(logs, ['sms_sent']);
  });

  it('dispatches one WebSocket job using the SMS gateway template', async () => {
    process.env.ENABLE_GETSMS = '0';
    enableGateway();

    const result = await enqueueOrderPaymentSms(
      null,
      order,
      paymentPageUrl,
      dependencies()
    );

    assert.equal(sent.length, 0);
    assert.equal(queued.length, 1);
    assert.equal(result.gateway.queued, true);
    assert.equal(result.gateway.jobId, queued[0].id);
    assert.equal(
      queued[0].message,
      formatPaymentMessage(order, paymentPageUrl, PAYMENT_MESSAGE_CHANNELS.SMS_GATEWAY)
    );
    assert.deepEqual(result.getsms, { skipped: true, reason: 'disabled' });
    assert.deepEqual(result.mtproto, { skipped: true, reason: 'disabled' });
  });

  it('dispatches through both independently enabled providers', async () => {
    enableGetSms();
    enableGateway();

    const result = await enqueueOrderPaymentSms(
      null,
      order,
      paymentPageUrl,
      dependencies()
    );

    assert.equal(sent.length, 1);
    assert.equal(queued.length, 1);
    assert.equal(result.getsms.sent, true);
    assert.equal(result.gateway.queued, true);
    assert.equal(sent[0].text, queued[0].message);
  });

  it('sends a distinct body per channel when templates differ', async () => {
    enableGetSms();
    enableGateway();
    enableMtproto();
    process.env.GETSMS_MESSAGE_TEMPLATE = 'GETSMS:{payment_page_url}';
    process.env.SMS_GATEWAY_MESSAGE_TEMPLATE = 'GATEWAY:{payment_page_url}';
    process.env.TELEGRAM_MTPROTO_MESSAGE_TEMPLATE = 'MTPROTO:{payment_page_url}';

    const result = await enqueueOrderPaymentSms(
      null,
      order,
      paymentPageUrl,
      dependencies()
    );

    assert.equal(result.getsms.sent, true);
    assert.equal(result.gateway.queued, true);
    assert.equal(result.mtproto.sent, true);
    assert.equal(sent[0].text, `GETSMS:${paymentPageUrl}`);
    assert.equal(queued[0].message, `GATEWAY:${paymentPageUrl}`);
    assert.equal(mtprotoSent[0].text, `MTPROTO:${paymentPageUrl}`);
  });

  it('dispatches through MTProto only', async () => {
    process.env.ENABLE_GETSMS = '0';
    process.env.SMS_GATEWAY_ENABLED = '0';
    enableMtproto();

    const result = await enqueueOrderPaymentSms(
      null,
      order,
      paymentPageUrl,
      dependencies()
    );

    assert.equal(mtprotoSent.length, 1);
    assert.equal(result.mtproto.sent, true);
    assert.equal(result.mtproto.userId, '42');
    assert.equal(
      mtprotoSent[0].text,
      formatPaymentMessage(order, paymentPageUrl, PAYMENT_MESSAGE_CHANNELS.MTPROTO)
    );
    assert.equal(mtprotoSent[0].withGreeting, true);
    assert.deepEqual(result.getsms, { skipped: true, reason: 'disabled' });
    assert.deepEqual(result.gateway, { skipped: true, reason: 'disabled' });
    assert.deepEqual(logs, ['telegram_mtproto_sent']);
  });

  it('continues SMS transports when MTProto fails', async () => {
    enableGetSms();
    process.env.SMS_GATEWAY_ENABLED = '0';
    enableMtproto();

    const result = await enqueueOrderPaymentSms(
      null,
      order,
      paymentPageUrl,
      dependencies({ mtprotoError: 'No Telegram user' })
    );

    assert.equal(result.getsms.sent, true);
    assert.equal(result.mtproto.sent, false);
    assert.deepEqual(logs, ['sms_sent', 'telegram_mtproto_failed']);
  });

  it('skips when neither provider is applicable', async () => {
    process.env.ENABLE_GETSMS = '0';
    process.env.SMS_GATEWAY_ENABLED = '1';
    delete process.env.REDIS_URL;

    const result = await enqueueOrderPaymentSms(
      null,
      order,
      paymentPageUrl,
      dependencies()
    );

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no_providers');
    assert.deepEqual(result.getsms, { skipped: true, reason: 'disabled' });
    assert.deepEqual(result.gateway, { skipped: true, reason: 'not_configured' });
    assert.deepEqual(result.mtproto, { skipped: true, reason: 'disabled' });
  });

  it('continues to the Android gateway when GETSMS fails', async () => {
    enableGetSms();
    enableGateway();

    const result = await enqueueOrderPaymentSms(
      null,
      order,
      paymentPageUrl,
      dependencies({ getsmsError: 'HTTP unavailable' })
    );

    assert.equal(result.getsms.sent, false);
    assert.equal(result.gateway.queued, true);
    assert.equal(queued.length, 1);
    assert.deepEqual(logs, ['sms_failed']);
  });

  it('keeps a successful GETSMS send when Android enqueue fails', async () => {
    enableGetSms();
    enableGateway();

    const result = await enqueueOrderPaymentSms(
      null,
      order,
      paymentPageUrl,
      dependencies({ gatewayError: 'Redis unavailable' })
    );

    assert.equal(result.getsms.sent, true);
    assert.equal(result.gateway.queued, false);
    assert.equal(sent.length, 1);
    assert.deepEqual(logs, ['sms_sent', 'sms_failed']);
  });
});
