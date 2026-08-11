const { getOrderById } = require('../db/partners-db');
const { formatClickUrl, isClickPaymentEnabled } = require('./click');
const {
  getOrCreatePaymeCheckoutUrl,
  syncPaymeReceiptStatus,
} = require('./payme-receipts');

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

function formatTicketAdminUrl(ticketId) {
  const { formatTicketAdminUrl: formatUrl } = require('../bot/order-ticket');
  return formatUrl(ticketId);
}

function getDefaultPaymentProvider() {
  return isClickPaymentEnabled() ? 'click' : 'payme';
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
  let order = getOrderById(db, orderId);
  if (!order) {
    return null;
  }

  // Sync Payme receipt before offering checkout so a paid receipt is not replaced.
  if (order.status === 'pending' && order.payme_receipt_id) {
    try {
      await syncPaymeReceiptStatus(db, orderId);
    } catch (error) {
      console.error('Payme sync before payment options failed:', error.message || error);
    }
    order = getOrderById(db, orderId) || order;
  }

  const payments = [];
  if (order.status === 'pending') {
    const paymeOption = await buildPaymePaymentOption(db, order);
    if (paymeOption) {
      payments.push(paymeOption);
    }
    if (isClickPaymentEnabled()) {
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
  const { publicDir } = require('../paths');
  return publicDir();
}

module.exports = {
  getPublicBaseUrl,
  isOrderId,
  formatPaymentPageUrl,
  formatTicketAdminUrl,
  getDefaultPaymentProvider,
  getPaymentOptionsForOrder,
  getPublicDir,
};
