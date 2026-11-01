import type { Db } from '../types/db';
import { recalculateAccountValue } from './accounts';
import { CURRENCIES, getUsdUzsRate, roundMoney } from './money';
import { getPaymentType } from './payment-types';
import { ensureTaskPaymentTables } from './task-payments-schema';

const MAX_PAYMENT_NOTE = 500;

const PAYMENT_KINDS = ['payment', 'refund'];

const PAYMENT_SELECT = `

  p.id, p.task_id, p.payment_type_id, p.payment_type_name, p.account_id,

  p.amount, p.currency, p.amount_uzs, p.amount_usd, p.usd_uzs_rate,

  p.kind, p.device_line_id, p.service_line_id, p.refunded_quantity, p.refund_id,

  p.note, p.created_by_user_id, p.created_at,

  u.display_name AS created_by_display_name,

  u.first_name AS created_by_first_name,

  u.last_name AS created_by_last_name,

  u.admin_login AS created_by_admin_login,

  u.username AS created_by_username

`;

const PAYMENT_FROM = `

  task_payments p

  LEFT JOIN bot_users u ON u.id = p.created_by_user_id

`;

function authorLabel(row?: any) {

  const fullName = [row.created_by_first_name, row.created_by_last_name]

    .filter(Boolean)

    .join(' ')

    .trim();

  return (

    row.created_by_display_name ||

    fullName ||

    row.created_by_admin_login ||

    (row.created_by_username ? `@${row.created_by_username}` : null)

  );

}

function mapTaskPayment(row?: any) {

  if (!row) return null;

  const currency = CURRENCIES.includes(row.currency) ? row.currency : 'UZS';

  const kind = PAYMENT_KINDS.includes(row.kind) ? row.kind : 'payment';

  return {

    id: row.id,

    task_id: row.task_id,

    payment_type_id: row.payment_type_id ?? null,

    payment_type_name: row.payment_type_name || '',

    account_id: row.account_id ?? null,

    amount: Number(row.amount) || 0,

    currency,

    amount_uzs: Number(row.amount_uzs) || 0,

    amount_usd: Number(row.amount_usd) || 0,

    usd_uzs_rate: Number(row.usd_uzs_rate) || 0,

    kind,

    device_line_id: row.device_line_id ?? null,

    service_line_id: row.service_line_id ?? null,

    refunded_quantity: row.refunded_quantity ?? null,

    refund_id: row.refund_id ?? null,

    note: row.note || '',

    created_by_user_id: row.created_by_user_id ?? null,

    created_by:

      row.created_by_user_id == null

        ? null

        : {

            id: row.created_by_user_id,

            name: authorLabel(row) || `Сотрудник #${row.created_by_user_id}`,

          },

    created_at: row.created_at,

  };

}

function normalizePaymentAmount(value?: any) {

  const amount = Number(value);

  if (!Number.isFinite(amount) || amount <= 0) throw new Error('INVALID_TASK_PAYMENT_AMOUNT');

  return roundMoney(amount);

}

function normalizePaymentNote(value?: any) {

  if (value == null) return null;

  const note = String(value).trim();

  if (note.length > MAX_PAYMENT_NOTE) throw new Error('INVALID_TASK_PAYMENT_NOTE');

  return note || null;

}

function normalizePaymentCurrency(value?: any, fallback?: any) {

  const raw = value == null || value === '' ? fallback : value;

  const currency = String(raw || '').trim().toUpperCase();

  if (!CURRENCIES.includes(currency)) throw new Error('INVALID_TASK_PAYMENT_CURRENCY');

  return currency;

}

function convertPaymentAmount(amount?: any, currency?: any, rate?: any) {

  if (currency === 'USD') {

    return { amount_uzs: roundMoney(amount * rate), amount_usd: roundMoney(amount) };

  }

  return { amount_uzs: roundMoney(amount), amount_usd: roundMoney(amount / rate) };

}

function taskExists(db: Db, taskId?: any) {

  const id = Number(taskId);

  if (!Number.isFinite(id) || id <= 0) return null;

  const row = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);

  return row ? row.id : null;

}

function insertTaskPaymentRecord(db: Db, taskId: any, paymentType: any, input: any = {}) {

  const amount = normalizePaymentAmount(input.amount);

  const currency = normalizePaymentCurrency(input.currency, paymentType.currency);

  const accountId = Number(paymentType.account_id);

  const note = normalizePaymentNote(input.note);

  const rate = getUsdUzsRate(db);

  const converted = convertPaymentAmount(amount, currency, rate);

  const createdBy = Number(input.created_by_user_id);

  const kind = PAYMENT_KINDS.includes(input.kind) ? input.kind : 'payment';

  const deviceLineId = Number(input.device_line_id);

  const serviceLineId = Number(input.service_line_id);

  const refundedQuantity = Number(input.refunded_quantity);

  const refundId = Number(input.refund_id);

  const result = db

    .prepare(

      `INSERT INTO task_payments (

         task_id, payment_type_id, payment_type_name, account_id, amount, currency,

         amount_uzs, amount_usd, usd_uzs_rate, kind,

         device_line_id, service_line_id, refunded_quantity, refund_id,

         note, created_by_user_id, created_at

       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`

    )

    .run(

      taskId,

      paymentType.id,

      paymentType.name,

      Number.isFinite(accountId) && accountId > 0 ? accountId : null,

      amount,

      currency,

      converted.amount_uzs,

      converted.amount_usd,

      rate,

      kind,

      Number.isFinite(deviceLineId) && deviceLineId > 0 ? deviceLineId : null,

      Number.isFinite(serviceLineId) && serviceLineId > 0 ? serviceLineId : null,

      Number.isFinite(refundedQuantity) && refundedQuantity > 0 ? refundedQuantity : null,

      Number.isFinite(refundId) && refundId > 0 ? refundId : null,

      note,

      Number.isFinite(createdBy) && createdBy > 0 ? createdBy : null

    );

  return Number(result.lastInsertRowid);

}

function listTaskPayments(db: Db, taskId?: any) {

  ensureTaskPaymentTables(db);

  const id = Number(taskId);

  if (!Number.isFinite(id) || id <= 0) return [];

  return db

    .prepare(

      `SELECT ${PAYMENT_SELECT}

       FROM ${PAYMENT_FROM}

       WHERE p.task_id = ?

       ORDER BY datetime(p.created_at) DESC, p.id DESC`

    )

    .all(id)

    .map(mapTaskPayment);

}

function getTaskPayment(db: Db, taskId?: any, paymentId?: any) {

  ensureTaskPaymentTables(db);

  const task = Number(taskId);

  const payment = Number(paymentId);

  if (!Number.isFinite(task) || task <= 0) return null;

  if (!Number.isFinite(payment) || payment <= 0) return null;

  return mapTaskPayment(

    db

      .prepare(`SELECT ${PAYMENT_SELECT} FROM ${PAYMENT_FROM} WHERE p.id = ? AND p.task_id = ?`)

      .get(payment, task)

  );

}

function createTaskPayment(db: Db, taskId: any, input: any = {}) {

  ensureTaskPaymentTables(db);

  const id = taskExists(db, taskId);

  if (!id) throw new Error('NOT_FOUND');

  const paymentType = getPaymentType(db, input.payment_type_id);

  if (!paymentType) throw new Error('INVALID_TASK_PAYMENT_TYPE');

  const paymentId = insertTaskPaymentRecord(db, id, paymentType, { ...input, kind: 'payment' });

  db.prepare(`UPDATE tasks SET updated_at = datetime('now') WHERE id = ?`).run(id);

  if (paymentType.account_id) recalculateAccountValue(db, paymentType.account_id);

  return getTaskPayment(db, id, paymentId);

}

function createTaskRefund(db: Db, taskId: any, input: any = {}) {

  ensureTaskPaymentTables(db);

  const id = taskExists(db, taskId);

  if (!id) throw new Error('NOT_FOUND');

  const paymentType = getPaymentType(db, input.payment_type_id);

  if (!paymentType) throw new Error('INVALID_TASK_PAYMENT_TYPE');

  const paymentId = insertTaskPaymentRecord(db, id, paymentType, { ...input, kind: 'refund' });

  if (paymentType.account_id) recalculateAccountValue(db, paymentType.account_id);

  return getTaskPayment(db, id, paymentId);

}

function deleteTaskPayment(db: Db, taskId?: any, paymentId?: any) {

  ensureTaskPaymentTables(db);

  const current = getTaskPayment(db, taskId, paymentId);

  if (!current) return false;

  db.prepare('DELETE FROM task_payments WHERE id = ?').run(current.id);

  db.prepare(`UPDATE tasks SET updated_at = datetime('now') WHERE id = ?`).run(current.task_id);

  if (current.account_id) recalculateAccountValue(db, current.account_id);

  return true;

}

function emptyTaskPaymentTotals() {

  return { paid_uzs: 0, paid_usd: 0, due_uzs: 0, due_usd: 0 };

}

function summarizeTaskPayments(payments?: any, totals?: any) {

  let paidUzs = 0;

  let paidUsd = 0;

  for (const payment of payments || []) {

    if (payment?.kind === 'refund') continue;

    paidUzs += Number(payment?.amount_uzs) || 0;

    paidUsd += Number(payment?.amount_usd) || 0;

  }

  const priceUzs = Number(totals?.price_uzs) || 0;

  const priceUsd = Number(totals?.price_usd) || 0;

  return {

    paid_uzs: roundMoney(paidUzs),

    paid_usd: roundMoney(paidUsd),

    due_uzs: roundMoney(priceUzs - paidUzs),

    due_usd: roundMoney(priceUsd - paidUsd),

  };

}

export {
  MAX_PAYMENT_NOTE,
  PAYMENT_KINDS,
  ensureTaskPaymentTables,
  listTaskPayments,
  getTaskPayment,
  createTaskPayment,
  createTaskRefund,
  deleteTaskPayment,
  emptyTaskPaymentTotals,
  summarizeTaskPayments,
};
