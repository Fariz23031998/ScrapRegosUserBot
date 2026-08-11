const {
  getOrderById,
  setOrderPaymeReceiptId,
  createPayment,
  markOrderPaid,
} = require('../db/partners-db');
const { uzsToTiyin, getPaymeCheckoutBase } = require('./payme');
const {
  createReceipt,
  checkReceipt,
  RECEIPT_STATE_OPEN,
  RECEIPT_STATE_PAID,
  RECEIPT_STATE_CANCELLED,
} = require('./payme-api');
const { notifyCreatorOrderPaid } = require('../bot/payment-notification');

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

async function markOrderPaidFromReceipt(db, order, receiptId) {
  const { claimed, order: paidOrder } = markOrderPaid(db, order.id, {
    transactionId: receiptId,
    provider: 'payme',
  });
  if (!claimed) {
    return { claimed: false, order: paidOrder || order };
  }

  createPayment(db, {
    orderId: order.id,
    telegramId: order.telegram_id,
    amount: order.amount,
    provider: 'payme',
    externalTransactionId: receiptId,
  });
  await notifyCreatorOrderPaid(paidOrder || order, { provider: 'payme', db });
  return { claimed: true, order: paidOrder || order };
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
    await markOrderPaidFromReceipt(db, order, order.payme_receipt_id);
    return { status: 'paid', receiptId: order.payme_receipt_id, receiptState: state };
  }

  return { status: 'pending', receiptId: order.payme_receipt_id, receiptState: state };
}

/**
 * Decide what to do with an existing Payme receipt before creating another.
 * Fail closed on API errors: reuse the stored receipt instead of creating a duplicate.
 */
async function resolveExistingReceipt(db, order) {
  const receiptId = order.payme_receipt_id;
  if (!receiptId) {
    return { action: 'create' };
  }

  let state;
  try {
    ({ state } = await checkReceipt(receiptId));
  } catch (error) {
    console.error(
      `Payme receipt check failed for ${receiptId}, reusing existing checkout:`,
      error.message || error
    );
    return { action: 'reuse', receiptId };
  }

  if (state === RECEIPT_STATE_PAID) {
    await markOrderPaidFromReceipt(db, order, receiptId);
    return { action: 'paid', receiptId, receiptState: state };
  }

  if (state === RECEIPT_STATE_CANCELLED) {
    return { action: 'create', receiptId, receiptState: state };
  }

  // OPEN or any other non-terminal in-progress state: reuse unless abandoned OPEN past TTL.
  if (state === RECEIPT_STATE_OPEN && isReceiptStale(order)) {
    return { action: 'create', receiptId, receiptState: state };
  }

  return { action: 'reuse', receiptId, receiptState: state };
}

async function getOrCreatePaymeCheckoutUrl(db, order) {
  const freshOrder = getOrderById(db, order.id);
  if (!freshOrder) {
    throw new Error('Order not found');
  }
  if (freshOrder.status === 'paid') {
    return null;
  }

  if (freshOrder.payme_receipt_id) {
    const resolved = await resolveExistingReceipt(db, freshOrder);
    if (resolved.action === 'paid') {
      return null;
    }
    if (resolved.action === 'reuse') {
      return formatReceiptCheckoutUrl(resolved.receiptId);
    }
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
  resolveExistingReceipt,
  markOrderPaidFromReceipt,
};
