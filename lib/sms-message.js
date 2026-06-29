const { normalizePhone } = require('./search-user');

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

function formatSmsPaymentMessage(order, paymentPageUrl) {
  const amount = order.amount;
  const currency = order.currency || 'UZS';
  return `Создан заказ на ${amount} ${currency}. Оплатите: ${paymentPageUrl}`;
}

module.exports = {
  formatPhoneForSms,
  resolveSmsRecipientPhone,
  formatSmsPaymentMessage,
};
