const path = require('path');
const { getOrderById } = require('./partners-db');
const { formatClickUrl } = require('./click');
const { getOrCreatePaymeCheckoutUrl } = require('./payme-receipts');

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
  return `${base}/pay?order_id=${encodeURIComponent(orderId)}`;
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

async function buildPaymePaymentOption(db, order) {
  try {
    const url = await getOrCreatePaymeCheckoutUrl(db, order);
    if (!url) {
      return null;
    }
    return {
      provider: 'payme',
      label: 'Payme',
      url,
      enabled: true,
    };
  } catch (error) {
    console.error('Payme payment option error:', error.message);
    return null;
  }
}

async function getPaymentOptionsForOrder(db, orderId) {
  const order = getOrderById(db, orderId);
  if (!order) {
    return null;
  }

  const payments = [];
  if (order.status === 'pending') {
    const paymeOption = await buildPaymePaymentOption(db, order);
    if (paymeOption) {
      payments.push(paymeOption);
    }
    if (process.env.ENABLE_CLICK_PAYMENT === '1') {
      const clickOption = buildClickPaymentOption(order);
      if (clickOption) {
        payments.push(clickOption);
      }
    }
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
