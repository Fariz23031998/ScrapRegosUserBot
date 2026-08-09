const { normalizePhone } = require('../bot/search-user');
const { escapeHtml } = require('../bot/telegram-html');

const DEFAULT_PAYMENT_MESSAGE_TEMPLATE = `Оплата услуг ROFEEV TECHNOLOGY
Ссылка на оплату создана на сумму {amount} {currency}.
Оплатить: {payment_page_url}
Служба поддержки (Telegram): {support_telegram_url}
Веб-сайт: {website_url}
Телефон: {support_phone}`;

/** @deprecated Use DEFAULT_PAYMENT_MESSAGE_TEMPLATE */
const DEFAULT_GETSMS_MESSAGE_TEMPLATE = DEFAULT_PAYMENT_MESSAGE_TEMPLATE;

const PAYMENT_MESSAGE_CHANNELS = Object.freeze({
  GETSMS: 'getsms',
  SMS_GATEWAY: 'sms_gateway',
  MTPROTO: 'mtproto',
});

const CHANNEL_TEMPLATE_ENV = Object.freeze({
  [PAYMENT_MESSAGE_CHANNELS.GETSMS]: 'GETSMS_MESSAGE_TEMPLATE',
  [PAYMENT_MESSAGE_CHANNELS.SMS_GATEWAY]: 'SMS_GATEWAY_MESSAGE_TEMPLATE',
  [PAYMENT_MESSAGE_CHANNELS.MTPROTO]: 'TELEGRAM_MTPROTO_MESSAGE_TEMPLATE',
});

function formatPhoneForSms(phone) {
  let digits = normalizePhone(phone);
  if (!digits) return null;

  if (digits.length === 9 && digits.startsWith('9')) {
    digits = `998${digits}`;
  }

  if (digits.length === 12 && digits.startsWith('998')) {
    return digits;
  }

  return null;
}

function resolveSmsRecipientPhone(order) {
  return order.additional_phone || order.client_phone;
}

function renderSmsTemplate(template, values) {
  return String(template).replace(/\{([^{}]+)\}/g, (placeholder, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      return placeholder;
    }
    return values[key] == null ? '' : String(values[key]);
  });
}

function formatSmsAmount(amount) {
  const raw = String(amount ?? '').trim();
  if (!raw) return '';

  const normalized = raw.replace(/\s+/g, '');
  if (!/^-?\d+(?:[.,]\d+)?$/.test(normalized)) {
    return raw;
  }

  const [integer, fraction] = normalized.replace(',', '.').split('.');
  const sign = integer.startsWith('-') ? '-' : '';
  const digits = sign ? integer.slice(1) : integer;
  const formatted = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${formatted}${fraction ? `.${fraction}` : ''}`;
}

function resolvePaymentMessageTemplate(channel = PAYMENT_MESSAGE_CHANNELS.GETSMS) {
  const channelEnv = CHANNEL_TEMPLATE_ENV[channel];
  if (!channelEnv) {
    throw new Error(`Unknown payment message channel: ${channel}`);
  }

  const channelTemplate = process.env[channelEnv];
  if (channelTemplate?.trim()) return channelTemplate;

  // Shared fallback so existing deployments that only set GETSMS_MESSAGE_TEMPLATE
  // keep the same body on SMS gateway and MTProto until they override per channel.
  if (channel !== PAYMENT_MESSAGE_CHANNELS.GETSMS) {
    const shared = process.env.GETSMS_MESSAGE_TEMPLATE;
    if (shared?.trim()) return shared;
  }

  return DEFAULT_PAYMENT_MESSAGE_TEMPLATE;
}

function formatPaymentMessage(order, paymentPageUrl, channel = PAYMENT_MESSAGE_CHANNELS.GETSMS) {
  const values = {
    amount: formatSmsAmount(order.amount),
    currency: order.currency || 'UZS',
    payment_page_url: paymentPageUrl,
    support_telegram_url:
      process.env.SMS_SUPPORT_TELEGRAM_URL?.trim() || 'https://t.me/EasyTradesupport_bot',
    website_url: process.env.SMS_WEBSITE_URL?.trim() || 'https://rofeev.uz',
    support_phone: process.env.SMS_SUPPORT_PHONE?.trim() || '+998 55 705-00-30',
  };

  // MTProto sends with parseMode HTML — escape dynamic values so URLs with & stay valid.
  // Template markup itself is left unescaped for the author to use <b>, <a>, etc.
  if (channel === PAYMENT_MESSAGE_CHANNELS.MTPROTO) {
    for (const key of Object.keys(values)) {
      values[key] = escapeHtml(values[key]);
    }
  }

  return renderSmsTemplate(resolvePaymentMessageTemplate(channel), values);
}

function formatGetSmsPaymentMessage(order, paymentPageUrl) {
  return formatPaymentMessage(order, paymentPageUrl, PAYMENT_MESSAGE_CHANNELS.GETSMS);
}

module.exports = {
  DEFAULT_PAYMENT_MESSAGE_TEMPLATE,
  DEFAULT_GETSMS_MESSAGE_TEMPLATE,
  PAYMENT_MESSAGE_CHANNELS,
  CHANNEL_TEMPLATE_ENV,
  formatPhoneForSms,
  resolveSmsRecipientPhone,
  renderSmsTemplate,
  formatSmsAmount,
  resolvePaymentMessageTemplate,
  formatPaymentMessage,
  formatGetSmsPaymentMessage,
};
