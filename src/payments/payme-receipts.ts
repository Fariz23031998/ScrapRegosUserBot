import type { Db } from '../types/db';
import { getOrderById, setOrderPaymeReceiptId, createPayment, markOrderPaid } from '../db/partners-db';
import { uzsToTiyin, getPaymeCheckoutBase } from './payme';
import { createReceipt, checkReceipt, RECEIPT_STATE_OPEN, RECEIPT_STATE_PAID, RECEIPT_STATE_CANCELLED } from './payme-api';
import { ensureCreatorPaidNotification } from '../bot/payment-notification';

// Payme checkout links expire after ~15000 seconds unless the merchant sets another timeout.
const DEFAULT_RECEIPT_TTL_MS = 15_000_000;

function getReceiptTtlMs() {
  const value = Number(process.env.PAYME_RECEIPT_TTL_MS);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_RECEIPT_TTL_MS;
  }
  return value;
}

function getReceiptTimeoutSec() {
  return Math.max(1, Math.floor(getReceiptTtlMs() / 1000));
}

function isReceiptStale(order: any, now: any = Date.now()) {
  const createdAt = Number(order.payme_receipt_created_at);
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    return true;
  }
  return now - createdAt >= getReceiptTtlMs();
}

function normalizeCustomerId(order?: any) {
  const phone = String(order.client_phone || '').replace(/\D/g, '');
  if (phone) {
    return phone;
  }
  return String(order.telegram_id);
}

function buildReceiptAccount(order?: any) {
  const description =
    process.env.PAYME_PAYMENT_DESCRIPTION || `Оплата заказа ${order.id}`;

  return {
    payment_uuid: order.id,
    payment_description: description,
    customer_id: normalizeCustomerId(order),
  };
}

function formatReceiptCheckoutUrl(receiptId?: any) {
  return `${getPaymeCheckoutBase()}/${receiptId}`;
}

function ensurePaymentRow(db: Db, order?: any, receiptId?: any) {
  const existing = db
    .prepare(
      `SELECT id FROM payments
       WHERE order_id = ? AND provider = 'payme' AND external_transaction_id = ?
       LIMIT 1`
    )
    .get(order.id, receiptId);
  if (existing) {
    return existing;
  }

  return createPayment(db, {
    orderId: order.id,
    telegramId: order.telegram_id,
    amount: order.amount,
    provider: 'payme',
    externalTransactionId: receiptId,
  });
}

async function markOrderPaidFromReceipt(db: Db, order?: any, receiptId?: any) {
  const { claimed, order: paidOrder } = markOrderPaid(db, order.id, {
    transactionId: receiptId,
    provider: 'payme',
  });
  const finalOrder = paidOrder || order;

  if (claimed) {
    try {
      ensurePaymentRow(db, finalOrder, receiptId);
    } catch (error: any) {
      console.error(
        `createPayment after Payme claim failed for order ${order.id}:`,
        error.message || error
      );
    }
  }

  // Always attempt notify (including claimed=false retries for paid-but-unnotified).
  await ensureCreatorPaidNotification(db, finalOrder, { provider: 'payme' });
  return { claimed, order: getOrderById(db, order.id) || finalOrder };
}

async function syncPaymeReceiptStatus(db: Db, orderId?: any) {
  const order = getOrderById(db, orderId);
  if (!order) {
    return { status: 'not_found' };
  }
  if (order.status === 'paid') {
    await ensureCreatorPaidNotification(db, order, {
      provider: order.payment_provider || 'payme',
    });
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
async function resolveExistingReceipt(db: Db, order?: any) {
  const receiptId = order.payme_receipt_id;
  if (!receiptId) {
    return { action: 'create' };
  }

  let state: any;
  try {
    ({ state } = await checkReceipt(receiptId));
  } catch (error: any) {
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

async function getOrCreatePaymeCheckoutUrl(db: Db, order?: any) {
  const freshOrder = getOrderById(db, order.id);
  if (!freshOrder) {
    throw new Error('Order not found');
  }
  if (freshOrder.status === 'paid') {
    await ensureCreatorPaidNotification(db, freshOrder, {
      provider: freshOrder.payment_provider || 'payme',
    });
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
    timeout: getReceiptTimeoutSec(),
  });

  setOrderPaymeReceiptId(db, freshOrder.id, receipt._id, Date.now());
  return formatReceiptCheckoutUrl(receipt._id);
}

export {
  DEFAULT_RECEIPT_TTL_MS,
  getReceiptTtlMs,
  getReceiptTimeoutSec,
  isReceiptStale,
  getOrCreatePaymeCheckoutUrl,
  syncPaymeReceiptStatus,
  formatReceiptCheckoutUrl,
  resolveExistingReceipt,
  markOrderPaidFromReceipt,
};
