import type { Unchecked } from '../src/types/unchecked';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GETSMS_MESSAGE_TEMPLATE, DEFAULT_PAYMENT_MESSAGE_TEMPLATE, PAYMENT_MESSAGE_CHANNELS, formatGetSmsPaymentMessage, formatPaymentMessage, renderSmsTemplate, resolvePaymentMessageTemplate } from '../src/sms/sms-message';
import { isGetSmsEnabled, sendGetSms } from '../src/sms/getsms-client';
import { clearEskizTokenCache, isEskizEnabled, sendEskiz } from '../src/sms/eskiz-client';
import { enqueueOrderPaymentSms } from '../src/sms/sms-queue';

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
  let previousEnv: any;

  before(() => {
    previousEnv = Object.fromEntries(SMS_ENV.map((key?: any) => [key, process.env[key]]));
  });

  after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value as any;
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
  let previousEnv: any;

  before(() => {
    previousEnv = Object.fromEntries(SMS_ENV.map((key?: any) => [key, process.env[key]]));
  });

  after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value as any;
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
    let request: any;

    const result = await sendGetSms(
      { phone: '+998 90 111 22 33', text: 'Test' },
      {
        fetchImpl: async (url?: any, options?: any) => {
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
    assert.deepEqual(JSON.parse((form.get('data') as any)), [
      { phone: '998901112233', text: 'Test' },
    ]);
  });
});

describe('Eskiz client', () => {
  let previousEnv: any;

  before(() => {
    previousEnv = Object.fromEntries(SMS_ENV.map((key?: any) => [key, process.env[key]]));
  });

  after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value as any;
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
    const calls: any[] = [];

    const result = await sendEskiz(
      { phone: '+998 90 111 22 33', text: 'Test' },
      {
        fetchImpl: async (url?: any, options?: any) => {
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
    const calls: any[] = [];

    const result = await sendEskiz(
      { phone: '998901112233', text: 'Retry' },
      {
        fetchImpl: async (url?: any, options?: any) => {
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
      calls.map((c?: any) => c.url.replace('https://eskiz.test', '')),
      ['/api/auth/login', '/api/message/sms/send', '/api/auth/refresh', '/api/message/sms/send']
    );
    assert.equal(calls[3].auth, 'Bearer tok-new');
  });
});
