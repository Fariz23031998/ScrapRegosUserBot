const { computeLineRefundAmount, getUsdUzsRate, roundMoney, CURRENCIES } = require('./money');
const { getPaymentType } = require('./payment-types');
const { createTaskRefund, listTaskPayments } = require('./task-payments');
const { ensureTaskTables, getTask, touchTask } = require('./tasks');

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function ensureColumn(db, table, column, ddl) {
  if (!tableExists(db, table)) return false;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col) => col.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return true;
}

function ensureTaskRefundTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_refunds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      note TEXT,
      created_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_refund_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      refund_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      device_line_id INTEGER,
      service_line_id INTEGER,
      name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      price_uzs REAL NOT NULL DEFAULT 0,
      price_usd REAL NOT NULL DEFAULT 0,
      price_without_discount_uzs REAL NOT NULL DEFAULT 0,
      price_without_discount_usd REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (refund_id) REFERENCES task_refunds(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_task_refunds_task_id ON task_refunds(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_refund_lines_refund_id ON task_refund_lines(refund_id);
  `);
  if (tableExists(db, 'task_payments')) {
    ensureColumn(db, 'task_payments', 'refund_id', 'INTEGER');
  }
}

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

function hasRefundPaymentInput(input = {}) {
  const typeId = Number(input.payment_type_id);
  if (Number.isFinite(typeId) && typeId > 0) return true;
  if (input.amount == null || String(input.amount).trim() === '') return false;
  return true;
}

function validateRefundAmount(amount, currency, maxRefund) {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('INVALID_TASK_PAYMENT_AMOUNT');
  const rounded = roundMoney(parsed);
  const max = currency === 'USD' ? maxRefund.price_usd : maxRefund.price_uzs;
  if (rounded > roundMoney(max) + 0.001) throw new Error('INVALID_TASK_REFUND_AMOUNT');
  return rounded;
}

function refundedQuantityForLine(db, kind, lineId) {
  const column = kind === 'device' ? 'device_line_id' : 'service_line_id';
  const row = db
    .prepare(`SELECT COALESCE(SUM(quantity), 0) AS qty FROM task_refund_lines WHERE ${column} = ?`)
    .get(lineId);
  return Number(row?.qty) || 0;
}

function authorLabel(row) {
  const fullName = [row.created_by_first_name, row.created_by_last_name].filter(Boolean).join(' ').trim();
  return (
    row.created_by_display_name ||
    fullName ||
    row.created_by_admin_login ||
    (row.created_by_username ? `@${row.created_by_username}` : null)
  );
}

function mapRefundLine(row) {
  if (!row) return null;
  return {
    id: row.id,
    refund_id: row.refund_id,
    kind: row.kind,
    device_line_id: row.device_line_id ?? null,
    service_line_id: row.service_line_id ?? null,
    name: row.name || '',
    quantity: Number(row.quantity) || 0,
    price_uzs: Number(row.price_uzs) || 0,
    price_usd: Number(row.price_usd) || 0,
    price_without_discount_uzs: Number(row.price_without_discount_uzs) || 0,
    price_without_discount_usd: Number(row.price_without_discount_usd) || 0,
  };
}

function mapRefund(row, lines = [], payments = []) {
  if (!row) return null;
  const priceUzs = lines.reduce((sum, line) => sum + (Number(line.price_uzs) || 0), 0);
  const priceUsd = lines.reduce((sum, line) => sum + (Number(line.price_usd) || 0), 0);
  return {
    id: row.id,
    task_id: row.task_id,
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
    lines,
    payments,
    totals: {
      price_uzs: roundMoney(priceUzs),
      price_usd: roundMoney(priceUsd),
    },
  };
}

function listRefundLineRows(db, refundIds) {
  if (!refundIds.length) return [];
  const placeholders = refundIds.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT id, refund_id, kind, device_line_id, service_line_id, name, quantity,
              price_uzs, price_usd, price_without_discount_uzs, price_without_discount_usd
       FROM task_refund_lines
       WHERE refund_id IN (${placeholders})
       ORDER BY id ASC`
    )
    .all(...refundIds)
    .map(mapRefundLine);
}

function listTaskRefunds(db, taskId, payments = null) {
  ensureTaskTables(db);
  ensureTaskRefundTables(db);
  const id = Number(taskId);
  if (!Number.isFinite(id) || id <= 0) return [];
  const rows = db
    .prepare(
      `SELECT r.id, r.task_id, r.note, r.created_by_user_id, r.created_at,
              u.display_name AS created_by_display_name,
              u.first_name AS created_by_first_name,
              u.last_name AS created_by_last_name,
              u.admin_login AS created_by_admin_login,
              u.username AS created_by_username
       FROM task_refunds r
       LEFT JOIN bot_users u ON u.id = r.created_by_user_id
       WHERE r.task_id = ?
       ORDER BY datetime(r.created_at) DESC, r.id DESC`
    )
    .all(id);
  if (!rows.length) return [];
  const lines = listRefundLineRows(
    db,
    rows.map((row) => row.id)
  );
  const linesByRefund = new Map();
  for (const line of lines) {
    const list = linesByRefund.get(line.refund_id) || [];
    list.push(line);
    linesByRefund.set(line.refund_id, list);
  }
  const allPayments = payments || listTaskPayments(db, id);
  const paymentsByRefund = new Map();
  for (const payment of allPayments) {
    if (payment.kind !== 'refund' || payment.refund_id == null) continue;
    const list = paymentsByRefund.get(payment.refund_id) || [];
    list.push(payment);
    paymentsByRefund.set(payment.refund_id, list);
  }
  return rows.map((row) =>
    mapRefund(row, linesByRefund.get(row.id) || [], paymentsByRefund.get(row.id) || [])
  );
}

function getTaskRefund(db, taskId, refundId, payments = null) {
  const id = Number(refundId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return listTaskRefunds(db, taskId, payments).find((item) => item.id === id) || null;
}

function deleteTaskRefunds(db, taskId) {
  ensureTaskRefundTables(db);
  const id = Number(taskId);
  if (!Number.isFinite(id) || id <= 0) return 0;
  const refundIds = db
    .prepare('SELECT id FROM task_refunds WHERE task_id = ?')
    .all(id)
    .map((row) => Number(row.id))
    .filter((refundId) => Number.isFinite(refundId) && refundId > 0);
  if (tableExists(db, 'task_payments')) {
    if (refundIds.length) {
      const placeholders = refundIds.map(() => '?').join(', ');
      db.prepare(`DELETE FROM task_payments WHERE refund_id IN (${placeholders})`).run(...refundIds);
    }
    db.prepare(`DELETE FROM task_payments WHERE task_id = ? AND kind = 'refund'`).run(id);
  }
  if (refundIds.length) {
    const placeholders = refundIds.map(() => '?').join(', ');
    db.prepare(`DELETE FROM task_refund_lines WHERE refund_id IN (${placeholders})`).run(...refundIds);
  }
  const result = db.prepare('DELETE FROM task_refunds WHERE task_id = ?').run(id);
  return Number(result.changes) || refundIds.length;
}

function refundTaskLine(db, taskId, input = {}, viewer) {
  ensureTaskTables(db);
  ensureTaskRefundTables(db);
  const id = Number(taskId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('NOT_FOUND');
  const task = getTask(db, id, viewer);
  if (!task) throw new Error('NOT_FOUND');
  if (task.status !== 'done') throw new Error('TASK_NOT_DONE');
  if (!task.posted) throw new Error('TASK_NOT_POSTED');

  const kind = normalizeRefundKind(input.kind);
  const lineId = Number(input.line_id);
  if (!Number.isFinite(lineId) || lineId <= 0) throw new Error('INVALID_TASK_REFUND_LINE');

  const line =
    kind === 'device' ? loadDeviceLineRow(db, id, lineId) : loadServiceLineRow(db, id, lineId);
  if (!line) throw new Error('INVALID_TASK_REFUND_LINE');

  const lineQty = lineQuantity(line.quantity);
  const alreadyRefunded = refundedQuantityForLine(db, kind, lineId);
  const remainingQty = lineQty - alreadyRefunded;
  const refundQty = normalizeRefundQuantity(input.quantity, remainingQty);
  const rate = getUsdUzsRate(db);
  const maxRefund = computeLineRefundAmount(line, refundQty, rate);
  const wantsPayment = hasRefundPaymentInput(input);
  let paymentType = null;
  let currency = null;
  let amount = null;
  if (wantsPayment) {
    paymentType = getPaymentType(db, input.payment_type_id);
    if (!paymentType) throw new Error('INVALID_TASK_PAYMENT_TYPE');
    const rawCurrency = input.currency == null || input.currency === '' ? paymentType.currency : input.currency;
    currency = String(rawCurrency || '').trim().toUpperCase();
    if (!CURRENCIES.includes(currency)) throw new Error('INVALID_TASK_PAYMENT_CURRENCY');
    amount = validateRefundAmount(input.amount, currency, maxRefund);
  }
  const lineName =
    kind === 'device'
      ? line.device_name || `Устройство #${line.device_id}`
      : line.service_name || `Услуга #${line.service_id}`;

  db.exec('BEGIN');
  try {
    const createdBy = Number(input.created_by_user_id);
    const refundResult = db
      .prepare(
        `INSERT INTO task_refunds (task_id, note, created_by_user_id, created_at)
         VALUES (?, ?, ?, datetime('now'))`
      )
      .run(
        id,
        input.note == null || String(input.note).trim() === '' ? null : String(input.note).trim().slice(0, 500),
        Number.isFinite(createdBy) && createdBy > 0 ? createdBy : null
      );
    const refundId = Number(refundResult.lastInsertRowid);
    db.prepare(
      `INSERT INTO task_refund_lines (
         refund_id, kind, device_line_id, service_line_id, name, quantity,
         price_uzs, price_usd, price_without_discount_uzs, price_without_discount_usd
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      refundId,
      kind,
      kind === 'device' ? lineId : null,
      kind === 'service' ? lineId : null,
      lineName,
      refundQty,
      maxRefund.price_uzs,
      maxRefund.price_usd,
      maxRefund.price_without_discount_uzs,
      maxRefund.price_without_discount_usd
    );
    const payment = wantsPayment
      ? createTaskRefund(db, id, {
          payment_type_id: paymentType.id,
          amount,
          currency,
          note: input.note,
          created_by_user_id: input.created_by_user_id,
          device_line_id: kind === 'device' ? lineId : null,
          service_line_id: kind === 'service' ? lineId : null,
          refunded_quantity: refundQty,
          refund_id: refundId,
        })
      : null;
    touchTask(db, id);
    db.exec('COMMIT');
    const updated = getTask(db, id, viewer);
    return {
      task: updated,
      refund: (updated.refunds || []).find((item) => item.id === refundId) || null,
      payment,
      line_name: lineName,
      kind,
      quantity: refundQty,
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  ensureTaskRefundTables,
  listTaskRefunds,
  getTaskRefund,
  refundTaskLine,
  hasRefundPaymentInput,
  deleteTaskRefunds,
};
