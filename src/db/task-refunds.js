const { computeLineRefundAmount, getUsdUzsRate, roundMoney, CURRENCIES } = require('./money');
const { getPaymentType } = require('./payment-types');
const { createTaskRefund } = require('./task-payments');
const { ensureTaskTables, getTask, touchTask } = require('./tasks');

function normalizeRefundKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  if (kind !== 'device' && kind !== 'service') throw new Error('INVALID_TASK_REFUND_LINE');
  return kind;
}

function normalizeRefundQuantity(value, maxQty) {
  const qty = Number(value);
  if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty < 1 || qty > maxQty) {
    throw new Error('INVALID_TASK_REFUND_QUANTITY');
  }
  return qty;
}

function lineQuantity(value) {
  const qty = Number(value);
  if (!Number.isFinite(qty) || qty < 1) return 1;
  return Math.trunc(qty);
}

function loadDeviceLineRow(db, taskId, lineId) {
  return (
    db
      .prepare(
        `SELECT td.id, td.task_id, td.device_id, td.action, td.notes, td.quantity, td.sort_order,
                td.cost_amount, td.cost_currency, td.price_uzs, td.price_usd,
                td.discount_type, td.discount_value, td.discount_currency,
                d.name AS device_name
         FROM task_devices td
         LEFT JOIN devices d ON d.id = td.device_id
         WHERE td.id = ? AND td.task_id = ?`
      )
      .get(lineId, taskId) || null
  );
}

function loadServiceLineRow(db, taskId, lineId) {
  return (
    db
      .prepare(
        `SELECT ts.id, ts.task_id, ts.service_id, ts.notes, ts.quantity, ts.sort_order,
                ts.cost_amount, ts.cost_currency, ts.price_uzs, ts.price_usd,
                ts.discount_type, ts.discount_value, ts.discount_currency,
                s.name AS service_name
         FROM task_services ts
         LEFT JOIN services s ON s.id = ts.service_id
         WHERE ts.id = ? AND ts.task_id = ?`
      )
      .get(lineId, taskId) || null
  );
}

function validateRefundAmount(amount, currency, maxRefund) {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('INVALID_TASK_PAYMENT_AMOUNT');
  const rounded = roundMoney(parsed);
  const max = currency === 'USD' ? maxRefund.price_usd : maxRefund.price_uzs;
  if (rounded > roundMoney(max) + 0.001) throw new Error('INVALID_TASK_REFUND_AMOUNT');
  return rounded;
}

function reduceLineQuantity(db, kind, taskId, lineId, refundQty) {
  const table = kind === 'device' ? 'task_devices' : 'task_services';
  const row = db.prepare(`SELECT quantity FROM ${table} WHERE id = ? AND task_id = ?`).get(lineId, taskId);
  if (!row) throw new Error('INVALID_TASK_REFUND_LINE');
  const currentQty = lineQuantity(row.quantity);
  const remainingQty = currentQty - refundQty;
  if (remainingQty <= 0) {
    db.prepare(`DELETE FROM ${table} WHERE id = ? AND task_id = ?`).run(lineId, taskId);
    return;
  }
  db.prepare(`UPDATE ${table} SET quantity = ? WHERE id = ? AND task_id = ?`).run(
    remainingQty,
    lineId,
    taskId
  );
}

function refundTaskLine(db, taskId, input = {}, viewer) {
  ensureTaskTables(db);
  const id = Number(taskId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('NOT_FOUND');
  const kind = normalizeRefundKind(input.kind);
  const lineId = Number(input.line_id);
  if (!Number.isFinite(lineId) || lineId <= 0) throw new Error('INVALID_TASK_REFUND_LINE');

  const line =
    kind === 'device' ? loadDeviceLineRow(db, id, lineId) : loadServiceLineRow(db, id, lineId);
  if (!line) throw new Error('INVALID_TASK_REFUND_LINE');

  const lineQty = lineQuantity(line.quantity);
  const refundQty = normalizeRefundQuantity(input.quantity, lineQty);
  const rate = getUsdUzsRate(db);
  const maxRefund = computeLineRefundAmount(line, refundQty, rate);
  const paymentType = getPaymentType(db, input.payment_type_id);
  if (!paymentType) throw new Error('INVALID_TASK_PAYMENT_TYPE');
  const rawCurrency = input.currency == null || input.currency === '' ? paymentType.currency : input.currency;
  const currency = String(rawCurrency || '').trim().toUpperCase();
  if (!CURRENCIES.includes(currency)) throw new Error('INVALID_TASK_PAYMENT_CURRENCY');
  const amount = validateRefundAmount(input.amount, currency, maxRefund);

  db.exec('BEGIN');
  try {
    reduceLineQuantity(db, kind, id, lineId, refundQty);
    const payment = createTaskRefund(db, id, {
      payment_type_id: paymentType.id,
      amount,
      currency,
      note: input.note,
      created_by_user_id: input.created_by_user_id,
      device_line_id: kind === 'device' ? lineId : null,
      service_line_id: kind === 'service' ? lineId : null,
      refunded_quantity: refundQty,
    });
    touchTask(db, id);
    db.exec('COMMIT');
    return {
      task: getTask(db, id, viewer),
      payment,
      line_name:
        kind === 'device'
          ? line.device_name || `Устройство #${line.device_id}`
          : line.service_name || `Услуга #${line.service_id}`,
      kind,
      quantity: refundQty,
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  refundTaskLine,
};
