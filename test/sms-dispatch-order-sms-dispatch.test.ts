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


describe('order SMS dispatch', () => {
  let previousEnv: any;
  let sent: any;
  let eskizSent: any;
  let queued: any;
  let mtprotoSent: any;
  let logs: any;

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
    sent = [];
    eskizSent = [];
    queued = [];
    mtprotoSent = [];
    logs = [];
  });

  function dependencies({ getsmsError, eskizError, gatewayError, mtprotoError }: Unchecked = {}) {
    return {
      sendGetSmsFn: async (payload?: any) => {
        sent.push(payload);
        if (getsmsError) throw new Error(getsmsError);
        return { requestId: 'request-1', messageId: 'message-1' };
      },
      sendEskizFn: async (payload?: any) => {
        eskizSent.push(payload);
        if (eskizError) throw new Error(eskizError);
        return { requestId: 'eskiz-request-1' };
      },
      enqueueSmsJobFn: async (job?: any) => {
        queued.push(job);
        if (gatewayError) throw new Error(gatewayError);
        return job;
      },
      sendTelegramByPhoneFn: async (payload?: any) => {
        mtprotoSent.push(payload);
        if (mtprotoError) throw new Error(mtprotoError);
        return {
          sent: true,
          recipient: `+${payload.phone}`,
          userId: '42',
          method: 'resolve_phone',
        };
      },
      logOrderEventFn: (_db?: any, event?: any) => logs.push(event.action),
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
      (null as any),
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
      (null as any),
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
      (null as any),
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
      (null as any),
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
      (null as any),
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
      (null as any),
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
      (null as any),
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
      (null as any),
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
      (null as any),
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
      (null as any),
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
      (null as any),
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
