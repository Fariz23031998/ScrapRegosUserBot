const path = require('path');
const { getOrderById } = require('./partners-db');
const { formatClickUrl } = require('./click');

function getPublicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
}

const ORDER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isOrderId(value) {
  return ORDER_ID_PATTERN.test(String(value || '').trim());
}

function formatPaymentPageUrl(orderId) {
  const base = getPublicBaseUrl();
  if (!base || !orderId) return null;
  return `${base}/${encodeURIComponent(orderId)}`;
}

function buildClickPaymentOption(order) {
  try {
    return {
      provider: 'click',
      label: 'CLICK',
      url: formatClickUrl(order.id, order.amount),
      enabled: true,
    };
  } catch {
    return null;
  }
}

function getPaymentOptionsForOrder(db, orderId) {
  const order = getOrderById(db, orderId);
  if (!order) {
    return null;
  }

  const payments = [];
  if (order.status === 'pending') {
    const clickOption = buildClickPaymentOption(order);
    if (clickOption) {
      payments.push(clickOption);
    }
    // Add more providers here later, e.g. Payme, Uzum.
  }

  return {
    order: {
      id: order.id,
      amount: order.amount,
      currency: order.currency || 'UZS',
      status: order.status,
      client_phone: order.client_phone,
      additional_phone: order.additional_phone,
      created_at: order.created_at,
      paid_at: order.paid_at,
    },
    payment_page_url: formatPaymentPageUrl(order.id),
    payments,
  };
}

function getPublicDir() {
  return path.join(__dirname, '..', 'public');
}

module.exports = {
  getPublicBaseUrl,
  isOrderId,
  formatPaymentPageUrl,
  getPaymentOptionsForOrder,
  getPublicDir,
};
