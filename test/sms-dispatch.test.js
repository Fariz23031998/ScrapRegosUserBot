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
const {
  clearEskizTokenCache,
  isEskizEnabled,
  sendEskiz,
} = require('../src/sms/eskiz-client');
const { enqueueOrderPaymentSms } = require('../src/sms/sms-queue');

const SMS_ENV = [
  'ENABLE_GETSMS',
  'GETSMS_LOGIN',
  'GETSMS_PASSWORD',
  'GETSMS_NICKNAME',
  'GETSMS_URL',
  'GETSMS_MESSAGE_TEMPLATE',
  'ENABLE_ESKIZ',
  'ESKIZ_EMAIL',
  'ESKIZ_PASSWORD',
  'ESKIZ_FROM',
  'ESKIZ_BASE_URL',
  'ESKIZ_MESSAGE_TEMPLATE',
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
    process.env.ESKIZ_MESSAGE_TEMPLATE = 'ESKIZ:{amount}';
    process.env.SMS_GATEWAY_MESSAGE_TEMPLATE = 'GATEWAY:{amount}';
    process.env.TELEGRAM_MTPROTO_MESSAGE_TEMPLATE = 'MTPROTO:{amount}';

    assert.equal(
      formatPaymentMessage(order, paymentPageUrl, PAYMENT_MESSAGE_CHANNELS.GETSMS),
      'GETSMS:50 000'
    );
    assert.equal(
      formatPaymentMessage(order, paymentPageUrl, PAYMENT_MESSAGE_CHANNELS.ESKIZ),
      'ESKIZ:50 000'
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

  it('falls back SMS gateway, Eskiz, and MTProto to GETSMS_MESSAGE_TEMPLATE when unset', () => {
    process.env.GETSMS_MESSAGE_TEMPLATE = 'SHARED:{amount}';

    assert.equal(
      resolvePaymentMessageTemplate(PAYMENT_MESSAGE_CHANNELS.SMS_GATEWAY),
      'SHARED:{amount}'
    );
    assert.equal(
      resolvePaymentMessageTemplate(PAYMENT_MESSAGE_CHANNELS.ESKIZ),
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
      resolvePaymentMessageTemplate(PAYMENT_MESSAGE_CHANNELS.ESKIZ),
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

describe('Eskiz client', () => {
  let previousEnv;

  before(() => {
    previousEnv = Object.fromEntries(SMS_ENV.map((key) => [key, process.env[key]]));
  });

  after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearEskizTokenCache();
  });

  beforeEach(() => {
    for (const key of SMS_ENV) delete process.env[key];
    clearEskizTokenCache();
  });

  it('requires the enable flag and nonblank credentials', () => {
    process.env.ENABLE_ESKIZ = '0';
    process.env.ESKIZ_EMAIL = 'user@example.uz';
    process.env.ESKIZ_PASSWORD = 'password';
    assert.equal(isEskizEnabled(), false);

    process.env.ENABLE_ESKIZ = '1';
    process.env.ESKIZ_PASSWORD = ' ';
    assert.equal(isEskizEnabled(), false);

    process.env.ESKIZ_PASSWORD = 'password';
    assert.equal(isEskizEnabled(), true);
  });

  it('logs in then posts multipart send and returns id', async () => {
    process.env.ESKIZ_EMAIL = 'user@example.uz';
    process.env.ESKIZ_PASSWORD = 'password';
    process.env.ESKIZ_FROM = 'ROFEEV';
    process.env.ESKIZ_BASE_URL = 'https://eskiz.test';
    const calls = [];

    const result = await sendEskiz(
      { phone: '+998 90 111 22 33', text: 'Test' },
      {
        fetchImpl: async (url, options) => {
          calls.push({ url, options });
          if (String(url).endsWith('/api/auth/login')) {
            return {
              ok: true,
              status: 200,
              text: async () =>
                JSON.stringify({
                  message: 'token_generated',
                  data: { token: 'tok-1' },
                  token_type: 'bearer',
                }),
            };
          }
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                id: '59bf10a2-aba8-4694-8fd5-0be20102a580',
                message: 'Waiting for SMS provider',
                status: 'waiting',
              }),
          };
        },
      }
    );

    assert.deepEqual(result, {
      requestId: '59bf10a2-aba8-4694-8fd5-0be20102a580',
      recipient: '998901112233',
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://eskiz.test/api/auth/login');
    assert.equal(calls[1].url, 'https://eskiz.test/api/message/sms/send');
    assert.equal(calls[1].options.headers.Authorization, 'Bearer tok-1');
    assert.ok(calls[1].options.body instanceof FormData);
    assert.equal(calls[1].options.body.get('mobile_phone'), '998901112233');
    assert.equal(calls[1].options.body.get('message'), 'Test');
    assert.equal(calls[1].options.body.get('from'), 'ROFEEV');
  });

  it('refreshes the token and retries once on 401', async () => {
    process.env.ESKIZ_EMAIL = 'user@example.uz';
    process.env.ESKIZ_PASSWORD = 'password';
    process.env.ESKIZ_BASE_URL = 'https://eskiz.test';
    const calls = [];

    const result = await sendEskiz(
      { phone: '998901112233', text: 'Retry' },
      {
        fetchImpl: async (url, options) => {
          calls.push({ url, method: options.method, auth: options.headers?.Authorization });
          if (String(url).endsWith('/api/auth/login')) {
            return {
              ok: true,
              status: 200,
              text: async () =>
                JSON.stringify({ data: { token: calls.length === 1 ? 'tok-old' : 'tok-login' } }),
            };
          }
          if (String(url).endsWith('/api/auth/refresh')) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({ data: { token: 'tok-new' } }),
            };
          }
          if (options.headers?.Authorization === 'Bearer tok-old') {
            return {
              ok: false,
              status: 401,
              text: async () => JSON.stringify({ message: 'Unauthenticated' }),
            };
          }
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ id: 'req-2', status: 'waiting' }),
          };
        },
      }
    );

    assert.equal(result.requestId, 'req-2');
    assert.deepEqual(
      calls.map((c) => c.url.replace('https://eskiz.test', '')),
      ['/api/auth/login', '/api/message/sms/send', '/api/auth/refresh', '/api/message/sms/send']
    );
    assert.equal(calls[3].auth, 'Bearer tok-new');
  });
});

describe('order SMS dispatch', () => {
  let previousEnv;
  let sent;
  let eskizSent;
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
    eskizSent = [];
    queued = [];
    mtprotoSent = [];
    logs = [];
  });

  function dependencies({ getsmsError, eskizError, gatewayError, mtprotoError } = {}) {
    return {
      sendGetSmsFn: async (payload) => {
        sent.push(payload);
        if (getsmsError) throw new Error(getsmsError);
        return { requestId: 'request-1', messageId: 'message-1' };
      },
      sendEskizFn: async (payload) => {
        eskizSent.push(payload);
        if (eskizError) throw new Error(eskizError);
        return { requestId: 'eskiz-request-1' };
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

  function enableEskiz() {
    process.env.ENABLE_ESKIZ = '1';
    process.env.ESKIZ_EMAIL = 'user@example.uz';
    process.env.ESKIZ_PASSWORD = 'password';
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
    assert.equal(eskizSent.length, 0);
    assert.equal(queued.length, 0);
    assert.equal(mtprotoSent.length, 0);
    assert.equal(result.getsms.sent, true);
    assert.deepEqual(result.eskiz, { skipped: true, reason: 'disabled' });
    assert.deepEqual(result.gateway, { skipped: true, reason: 'disabled' });
    assert.deepEqual(result.mtproto, { skipped: true, reason: 'disabled' });
    assert.deepEqual(logs, ['sms_sent']);
  });

  it('dispatches through Eskiz only', async () => {
    enableEskiz();
    process.env.SMS_GATEWAY_ENABLED = '0';

    const result = await enqueueOrderPaymentSms(
      null,
      order,
      paymentPageUrl,
      dependencies()
    );

    assert.equal(eskizSent.length, 1);
    assert.equal(sent.length, 0);
    assert.equal(result.eskiz.sent, true);
    assert.equal(result.eskiz.requestId, 'eskiz-request-1');
    assert.equal(
      eskizSent[0].text,
      formatPaymentMessage(order, paymentPageUrl, PAYMENT_MESSAGE_CHANNELS.ESKIZ)
    );
    assert.deepEqual(result.getsms, { skipped: true, reason: 'disabled' });
    assert.deepEqual(result.gateway, { skipped: true, reason: 'disabled' });
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
    assert.deepEqual(result.eskiz, { skipped: true, reason: 'disabled' });
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
    enableEskiz();
    enableGateway();
    enableMtproto();
    process.env.GETSMS_MESSAGE_TEMPLATE = 'GETSMS:{payment_page_url}';
    process.env.ESKIZ_MESSAGE_TEMPLATE = 'ESKIZ:{payment_page_url}';
    process.env.SMS_GATEWAY_MESSAGE_TEMPLATE = 'GATEWAY:{payment_page_url}';
    process.env.TELEGRAM_MTPROTO_MESSAGE_TEMPLATE = 'MTPROTO:{payment_page_url}';

    const result = await enqueueOrderPaymentSms(
      null,
      order,
      paymentPageUrl,
      dependencies()
    );

    assert.equal(result.getsms.sent, true);
    assert.equal(result.eskiz.sent, true);
    assert.equal(result.gateway.queued, true);
    assert.equal(result.mtproto.sent, true);
    assert.equal(sent[0].text, `GETSMS:${paymentPageUrl}`);
    assert.equal(eskizSent[0].text, `ESKIZ:${paymentPageUrl}`);
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
    assert.deepEqual(result.eskiz, { skipped: true, reason: 'disabled' });
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
    assert.deepEqual(result.eskiz, { skipped: true, reason: 'disabled' });
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

  it('continues when Eskiz fails independently of GETSMS', async () => {
    enableGetSms();
    enableEskiz();
    process.env.SMS_GATEWAY_ENABLED = '0';

    const result = await enqueueOrderPaymentSms(
      null,
      order,
      paymentPageUrl,
      dependencies({ eskizError: 'Eskiz unavailable' })
    );

    assert.equal(result.getsms.sent, true);
    assert.equal(result.eskiz.sent, false);
    assert.deepEqual(logs, ['sms_sent', 'sms_failed']);
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
