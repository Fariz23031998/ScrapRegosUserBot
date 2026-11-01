import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { logOrderEvent } from './order-logs';
import { resolveListOrderBy } from './list-sort';
import { getBotUser, getBotUserByTelegramId, getBotUserById, getEmployeeByPhone, findUserByPhone, getBotUsersByPhone, linkEmployeeTelegram, registerCustomer, createEmployeeUser, updateEmployeeUser, deleteEmployeeUser, listEmployeeUsers, getEmployeeWithRights, getUserRights, upsertUserRights, countBotUsers, isLinkedEmployee, getAllUnpaidOrders, deletePendingOrder, deletePaidCashOrder, markPendingOrderPaidCash, getEarningsRows } from './bot-users-db';
import { partnerFromApiRow, partnerAccountFromApiRow, licenseFromApiRow, vcr1PartnerFromApiRow, vcr1LicenseFromApiRow, partnerFromTableRow, partnerAccountFromTableRow, licenseFromTableRow, rposClientFromRow, rposAccountFromRow } from '../live/mappers';

function createOrder(
  db: Db,
  {
    id,
    telegramId,
    botUserPhone,
    clientPhone,
    clientType,
    additionalPhone = null,
    amount,
    currency = 'UZS',
    status = 'pending',
    paymentProvider = 'click',
    metadata = null,
    ticketId = null,
  }: Unchecked
) {
  const normalizedTicketId =
    ticketId == null || ticketId === '' ? null : Number(ticketId);
  db.prepare(
    `INSERT INTO orders (
      id, telegram_id, bot_user_phone, client_phone, client_type, additional_phone,
      amount, currency, status, payment_provider, metadata, ticket_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    id,
    telegramId,
    botUserPhone ?? null,
    clientPhone,
    clientType ?? null,
    additionalPhone,
    amount,
    currency,
    status,
    paymentProvider,
    metadata,
    Number.isFinite(normalizedTicketId) ? normalizedTicketId : null
  );
  const order = getOrderById(db, id);
  logOrderEvent(db, {
    orderId: id,
    action: 'created',
    actorTelegramId: telegramId,
    actorPhone: botUserPhone ?? null,
    orderAmount: amount,
    clientPhone,
    additionalPhone,
  });
  return order;
}

function getOrderById(db: Db, orderId?: any) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) ?? null;
}

const ORDER_LIST_STATUSES: Set<any> = new Set(['pending', 'paid', 'paid_cash', 'deleted']);
const ORDER_PAYMENT_PROVIDERS: Set<any> = new Set(['payme', 'click', 'cash']);
const PAID_LIST_STATUSES = ['paid', 'paid_cash'];

function summarizeOrders(rows?: any) {
  const summary = {
    count: Array.isArray(rows) ? rows.length : 0,
    pending: 0,
    paid: 0,
    deleted: 0,
    amount: 0,
  };
  for (const row of rows || []) {
    const status = String(row?.status || '');
    if (status === 'pending') summary.pending += 1;
    else if (status === 'paid' || status === 'paid_cash') summary.paid += 1;
    else if (status === 'deleted') summary.deleted += 1;
    if (status === 'paid' || status === 'paid_cash') {
      const amount = Number(row?.amount);
      if (Number.isFinite(amount)) summary.amount += amount;
    }
  }
  return summary;
}

function orderMatchesQuery(order?: any, query?: any) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return true;

  const lower = trimmed.toLowerCase();
  const digits = lower.replace(/\D/g, '');
  const phones = [order.client_phone, order.additional_phone, order.bot_user_phone].filter(
    Boolean
  );

  if (digits && phones.some((phone?: any) => String(phone).replace(/\D/g, '').includes(digits))) {
    return true;
  }

  const searchable = [
    order.id,
    order.client_phone,
    order.additional_phone,
    order.bot_user_phone,
    order.status,
    order.payment_provider,
    order.ticket_id != null ? String(order.ticket_id) : '',
    order.amount != null ? String(order.amount) : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return searchable.includes(lower);
}

function parseClientPhoneFilter(value?: any) {
  return String(value || '')
    .split(/[,;\s]+/)
    .map((part?: any) => part.trim())
    .filter(Boolean);
}

function orderMatchesClientPhone(order?: any, clientPhone?: any) {
  const phones = parseClientPhoneFilter(clientPhone);
  if (!phones.length) return true;
  return phones.some(
    (phone?: any) =>
      phonesMatch(order.client_phone, phone) || phonesMatch(order.additional_phone, phone)
  );
}

const ORDER_SORT_COLUMNS: Record<string, string> = {
  created_at: 'datetime(created_at)',
  id: 'id',
  status: 'status COLLATE NOCASE',
  amount: 'amount',
  client_phone: 'client_phone COLLATE NOCASE',
  additional_phone: 'additional_phone COLLATE NOCASE',
  employee: `(SELECT COALESCE(NULLIF(TRIM(bu.display_name), ''), NULLIF(TRIM(COALESCE(bu.first_name, '') || ' ' || COALESCE(bu.last_name, '')), ''), bu.username) FROM bot_users bu WHERE bu.telegram_id = orders.telegram_id) COLLATE NOCASE`,
  payment: 'payment_provider COLLATE NOCASE',
  ticket: 'ticket_id',
};

function listOrders(
  db: Db,
  { query, clientPhone, status, paymentProvider, from, to, telegramId, offset = 0, limit = 25, sort }: Unchecked = {}
) {
  let sql = 'SELECT * FROM orders WHERE 1=1';
  const params: any[] = [];

  if (status === 'paid') {
    sql += ` AND status IN (${PAID_LIST_STATUSES.map(() => '?').join(', ')})`;
    params.push(...PAID_LIST_STATUSES);
  } else if (status && ORDER_LIST_STATUSES.has(status)) {
    sql += ' AND status = ?';
    params.push(status);
  }

  const provider = String(paymentProvider || '').trim();
  if (provider && ORDER_PAYMENT_PROVIDERS.has(provider)) {
    sql += ` AND payment_provider = ? AND status IN (${PAID_LIST_STATUSES.map(() => '?').join(', ')})`;
    params.push(provider, ...PAID_LIST_STATUSES);
  }

  const employeeTelegramId = Number(telegramId);
  if (Number.isFinite(employeeTelegramId) && employeeTelegramId !== 0) {
    sql += ' AND telegram_id = ?';
    params.push(employeeTelegramId);
  }

  const fromDate = String(from || '').trim();
  if (fromDate) {
    sql += ' AND date(created_at) >= date(?)';
    params.push(fromDate);
  }

  const toDate = String(to || '').trim();
  if (toDate) {
    sql += ' AND date(created_at) <= date(?)';
    params.push(toDate);
  }

  sql += ` ${resolveListOrderBy(sort, ORDER_SORT_COLUMNS, 'id') || 'ORDER BY datetime(created_at) DESC'}`;

  let rows = db.prepare(sql).all(...params);
  if (clientPhone) {
    rows = rows.filter((row?: any) => orderMatchesClientPhone(row, clientPhone));
  }
  if (query) {
    rows = rows.filter((row?: any) => orderMatchesQuery(row, query));
  }

  const total = rows.length;
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  return {
    orders: rows.slice(safeOffset, safeOffset + safeLimit),
    total,
    summary: summarizeOrders(rows),
  };
}

function setOrderPaymeReceiptId(db: Db, orderId: any, receiptId: any, receiptCreatedAt: any = Date.now()) {
  db.prepare(
    'UPDATE orders SET payme_receipt_id = ?, payme_receipt_created_at = ? WHERE id = ?'
  ).run(receiptId, receiptCreatedAt, orderId);
  return getOrderById(db, orderId);
}

function claimOrderPaidNotification(db: Db, orderId?: any) {
  const result = db
    .prepare(
      `UPDATE orders
       SET paid_notified_at = datetime('now')
       WHERE id = ? AND status = 'paid' AND paid_notified_at IS NULL`
    )
    .run(orderId);
  return result.changes > 0;
}

function clearOrderPaidNotificationClaim(db: Db, orderId?: any) {
  db.prepare(
    `UPDATE orders
     SET paid_notified_at = NULL
     WHERE id = ? AND paid_notified_at IS NOT NULL`
  ).run(orderId);
  return getOrderById(db, orderId);
}

function markOrderPaid(
  db: Db,
  orderId: any,
  { clickTransId = null, transactionId = null, provider = null }: Unchecked = {}
) {
  const { activateTechnicalSupportFromOrder } = (require('./technical-support') as typeof import('./technical-support'));
  const transId = transactionId ?? clickTransId;

  db.exec('BEGIN');
  try {
    const result = db
      .prepare(
        `UPDATE orders
         SET status = 'paid',
             payment_transaction_id = ?,
             payment_provider = COALESCE(?, payment_provider),
             paid_at = datetime('now')
         WHERE id = ? AND status = 'pending'`
      )
      .run(transId, provider, orderId);

    const order = getOrderById(db, orderId);
    if (result.changes > 0 && order) {
      activateTechnicalSupportFromOrder(db, order, { paidAt: order.paid_at });
      logOrderEvent(db, {
        orderId,
        action: 'paid',
        actorTelegramId: order.telegram_id,
        orderAmount: order.amount,
        clientPhone: order.client_phone,
        additionalPhone: order.additional_phone,
        paymentProvider: order.payment_provider || provider || null,
      });
    }

    db.exec('COMMIT');
    return {
      claimed: result.changes > 0,
      order,
    };
  } catch (error: any) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  }
}

function createPayment(
  db: Db,
  {
    orderId,
    telegramId,
    amount,
    provider = 'click',
    clickTransId = null,
    externalTransactionId = null,
  }: Unchecked
) {
  const extId = externalTransactionId ?? clickTransId;
  const result = db
    .prepare(
      `INSERT INTO payments (
        order_id, telegram_id, amount, provider, click_trans_id,
        external_transaction_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .run(orderId, telegramId, amount, provider, clickTransId, extId);
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(result.lastInsertRowid) ?? null;
}

function getPaymeTransaction(db: Db, paymeId?: any) {
  return db.prepare('SELECT * FROM payme_transactions WHERE payme_id = ?').get(paymeId) ?? null;
}

function getActivePaymeTransactionForOrder(db: Db, orderId?: any) {
  return (
    db
      .prepare(
        `SELECT * FROM payme_transactions
         WHERE order_id = ? AND state = 1
         ORDER BY create_time DESC
         LIMIT 1`
      )
      .get(orderId) ?? null
  );
}

function insertPaymeTransaction(
  db: Db,
  { paymeId, orderId, amount, state, createTime, performTime = null, cancelTime = null, cancelReason = null }: Unchecked
) {
  db.prepare(
    `INSERT INTO payme_transactions (
      payme_id, order_id, amount, state, create_time,
      perform_time, cancel_time, cancel_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(paymeId, orderId, amount, state, createTime, performTime, cancelTime, cancelReason);
  return getPaymeTransaction(db, paymeId);
}

function updatePaymeTransaction(db: Db, paymeId: any, { state, performTime, cancelTime, cancelReason }: Unchecked = {}) {
  const fields: any[] = [];
  const values: any[] = [];
  if (state !== undefined) {
    fields.push('state = ?');
    values.push(state);
  }
  if (performTime !== undefined) {
    fields.push('perform_time = ?');
    values.push(performTime);
  }
  if (cancelTime !== undefined) {
    fields.push('cancel_time = ?');
    values.push(cancelTime);
  }
  if (cancelReason !== undefined) {
    fields.push('cancel_reason = ?');
    values.push(cancelReason);
  }
  if (fields.length === 0) {
    return getPaymeTransaction(db, paymeId);
  }
  values.push(paymeId);
  db.prepare(`UPDATE payme_transactions SET ${fields.join(', ')} WHERE payme_id = ?`).run(...values);
  return getPaymeTransaction(db, paymeId);
}

function normalizePhone(value?: any) {
  return String(value || '').replace(/\D/g, '');
}

function phonesMatch(storedPhone?: any, queryPhone?: any) {
  const stored = normalizePhone(storedPhone);
  const query = normalizePhone(queryPhone);
  if (!stored || !query) return false;
  if (stored === query) return true;
  if (stored.endsWith(query) || query.endsWith(stored)) return true;
  const storedTail = stored.slice(-9);
  const queryTail = query.slice(-9);
  return storedTail.length >= 9 && storedTail === queryTail;
}

function getUnpaidOrdersByClientPhone(db: Db, clientPhone?: any) {
  if (!clientPhone) return [];
  const orders = db
    .prepare("SELECT * FROM orders WHERE status = 'pending' ORDER BY datetime(created_at) DESC")
    .all();
  return orders.filter((row?: any) => phonesMatch(row.client_phone, clientPhone));
}

function getUnpaidOrdersByUserPhone(db: Db, userPhone?: any) {
  if (!userPhone) return [];
  const orders = db
    .prepare("SELECT * FROM orders WHERE status = 'pending' ORDER BY datetime(created_at) DESC")
    .all();
  return orders.filter(
    (row?: any) => phonesMatch(row.client_phone, userPhone) || phonesMatch(row.additional_phone, userPhone)
  );
}

function getUnpaidOrdersByCreatorTelegramId(db: Db, telegramId?: any) {
  if (telegramId == null) return [];
  return db
    .prepare(
      "SELECT * FROM orders WHERE telegram_id = ? AND status = 'pending' ORDER BY datetime(created_at) DESC"
    )
    .all(telegramId);
}

function getLatestUnpaidOrderByClientPhone(db: Db, clientPhone?: any) {
  return getUnpaidOrdersByClientPhone(db, clientPhone)[0] ?? null;
}

function listPendingOrdersWithPaymeReceipt(db: Db) {
  return db
    .prepare(
      `SELECT * FROM orders
       WHERE status = 'pending'
         AND payme_receipt_id IS NOT NULL
         AND TRIM(payme_receipt_id) != ''
       ORDER BY datetime(created_at) ASC`
    )
    .all();
}

function listPaymeOrdersForReconcile(db: Db, { pendingCreatedAfterMs }: Unchecked = {}) {
  const createdAfter = Number(pendingCreatedAfterMs);
  const hasCutoff = Number.isFinite(createdAfter) && createdAfter > 0;
  const sql = `SELECT * FROM orders
       WHERE (
         (
           status = 'pending'
           AND payme_receipt_id IS NOT NULL
           AND TRIM(payme_receipt_id) != ''
           ${
             hasCutoff
               ? 'AND payme_receipt_created_at IS NOT NULL AND payme_receipt_created_at > ?'
               : ''
           }
         )
         OR (
           status = 'paid'
           AND payment_provider = 'payme'
           AND paid_notified_at IS NULL
         )
       )
       ORDER BY datetime(created_at) ASC`;
  return hasCutoff ? db.prepare(sql).all(createdAfter) : db.prepare(sql).all();
}

export { DEFAULT_DB_PATH, openDb } from './partners-schema';
export {
  partnerFromApiRow,
  partnerAccountFromApiRow,
  licenseFromApiRow,
  vcr1PartnerFromApiRow,
  vcr1LicenseFromApiRow,
  partnerFromTableRow,
  partnerAccountFromTableRow,
  licenseFromTableRow,
  rposClientFromRow,
  rposAccountFromRow,
  getBotUser,
  getBotUserByTelegramId,
  getBotUserById,
  getEmployeeByPhone,
  findUserByPhone,
  getBotUsersByPhone,
  linkEmployeeTelegram,
  registerCustomer,
  createEmployeeUser,
  updateEmployeeUser,
  deleteEmployeeUser,
  listEmployeeUsers,
  getEmployeeWithRights,
  getUserRights,
  upsertUserRights,
  countBotUsers,
  isLinkedEmployee,
  getAllUnpaidOrders,
  deletePendingOrder,
  deletePaidCashOrder,
  markPendingOrderPaidCash,
  getEarningsRows,
  createOrder,
  getOrderById,
  listOrders,
  setOrderPaymeReceiptId,
  markOrderPaid,
  createPayment,
  getPaymeTransaction,
  getActivePaymeTransactionForOrder,
  insertPaymeTransaction,
  updatePaymeTransaction,
  getUnpaidOrdersByClientPhone,
  getUnpaidOrdersByUserPhone,
  getUnpaidOrdersByCreatorTelegramId,
  getLatestUnpaidOrderByClientPhone,
  listPendingOrdersWithPaymeReceipt,
  listPaymeOrdersForReconcile,
  claimOrderPaidNotification,
  clearOrderPaidNotificationClaim,
};
