const {
  getOrderById,
  setOrderPaymeReceiptId,
  createPayment,
  markOrderPaid,
} = require('./partners-db');
const { uzsToTiyin, getPaymeCheckoutBase } = require('./payme');
const {
  createReceipt,
  checkReceipt,
  RECEIPT_STATE_OPEN,
  RECEIPT_STATE_PAID,
} = require('./payme-api');

const DEFAULT_RECEIPT_TTL_MS = 12 * 60 * 60 * 1000;

function getReceiptTtlMs() {
  const value = Number(process.env.PAYME_RECEIPT_TTL_MS);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_RECEIPT_TTL_MS;
  }
  return value;
}

function isReceiptStale(order) {
  const createdAt = Number(order.payme_receipt_created_at);
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    return true;
  }
  return Date.now() - createdAt >= getReceiptTtlMs();
}

function normalizeCustomerId(order) {
  const phone = String(order.client_phone || '').replace(/\D/g, '');
  if (phone) {
    return phone;
  }
  return String(order.telegram_id);
}

function buildReceiptAccount(order) {
  const description =
    process.env.PAYME_PAYMENT_DESCRIPTION || `Оплата заказа ${order.id}`;

  return {
    payment_uuid: order.id,
    payment_description: description,
    customer_id: normalizeCustomerId(order),
  };
}

function formatReceiptCheckoutUrl(receiptId) {
  return `${getPaymeCheckoutBase()}/${receiptId}`;
}

async function isReceiptReusable(receiptId) {
  try {
    const { state } = await checkReceipt(receiptId);
    return state === RECEIPT_STATE_OPEN;
  } catch {
    return false;
  }
}

function markOrderPaidFromReceipt(db, order, receiptId) {
  createPayment(db, {
    orderId: order.id,
    telegramId: order.telegram_id,
    amount: order.amount,
    provider: 'payme',
    externalTransactionId: receiptId,
  });
  markOrderPaid(db, order.id, { transactionId: receiptId, provider: 'payme' });
}

async function syncPaymeReceiptStatus(db, orderId) {
  const order = getOrderById(db, orderId);
  if (!order) {
    return { status: 'not_found' };
  }
  if (order.status === 'paid') {
    return { status: 'paid', receiptId: order.payme_receipt_id ?? null };
  }
  if (!order.payme_receipt_id) {
    return { status: 'pending', receiptId: null };
  }

  const { state } = await checkReceipt(order.payme_receipt_id);
  if (state === RECEIPT_STATE_PAID) {
    markOrderPaidFromReceipt(db, order, order.payme_receipt_id);
    return { status: 'paid', receiptId: order.payme_receipt_id, receiptState: state };
  }

  return { status: 'pending', receiptId: order.payme_receipt_id, receiptState: state };
}

async function getOrCreatePaymeCheckoutUrl(db, order) {
  const freshOrder = getOrderById(db, order.id);
  if (!freshOrder) {
    throw new Error('Order not found');
  }
  if (freshOrder.status === 'paid') {
    return null;
  }

  if (
    freshOrder.payme_receipt_id &&
    !isReceiptStale(freshOrder) &&
    (await isReceiptReusable(freshOrder.payme_receipt_id))
  ) {
    return formatReceiptCheckoutUrl(freshOrder.payme_receipt_id);
  }

  const account = buildReceiptAccount(freshOrder);
  const description = account.payment_description;
  const receipt = await createReceipt({
    amountTiyin: uzsToTiyin(freshOrder.amount),
    account,
    description,
  });

  setOrderPaymeReceiptId(db, freshOrder.id, receipt._id, Date.now());
  return formatReceiptCheckoutUrl(receipt._id);
}

module.exports = {
  getOrCreatePaymeCheckoutUrl,
  syncPaymeReceiptStatus,
  formatReceiptCheckoutUrl,
};
