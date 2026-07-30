const { normalizePhone } = require('../bot/search-user');

const DEFAULT_GETSMS_MESSAGE_TEMPLATE = `Оплата услуг ROFEEV TECHNOLOGY
Ссылка на оплату создана на сумму {amount} {currency}.
Оплатить: {payment_page_url}
Служба поддержки (Telegram): {support_telegram_url}
Веб-сайт: {website_url}
Телефон: {support_phone}`;

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

function formatGetSmsPaymentMessage(order, paymentPageUrl) {
  const template = process.env.GETSMS_MESSAGE_TEMPLATE || DEFAULT_GETSMS_MESSAGE_TEMPLATE;
  return renderSmsTemplate(template, {
    amount: formatSmsAmount(order.amount),
    currency: order.currency || 'UZS',
    payment_page_url: paymentPageUrl,
    support_telegram_url:
      process.env.SMS_SUPPORT_TELEGRAM_URL?.trim() || 'https://t.me/EasyTradesupport_bot',
    website_url: process.env.SMS_WEBSITE_URL?.trim() || 'https://rofeev.uz',
    support_phone: process.env.SMS_SUPPORT_PHONE?.trim() || '+998 55 705-00-30',
  });
}

module.exports = {
  DEFAULT_GETSMS_MESSAGE_TEMPLATE,
  formatPhoneForSms,
  resolveSmsRecipientPhone,
  renderSmsTemplate,
  formatSmsAmount,
  formatGetSmsPaymentMessage,
};
