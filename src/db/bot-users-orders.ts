import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { logOrderEvent } from './order-logs';

function getAllUnpaidOrders(db: Db) {
  return db
    .prepare("SELECT * FROM orders WHERE status = 'pending' ORDER BY datetime(created_at) DESC")
    .all();
}

function deletePendingOrder(db: Db, orderId: any, actorTelegramId: any = null) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.status !== 'pending') {
    return false;
  }

  const result = db
    .prepare("UPDATE orders SET status = 'deleted' WHERE id = ? AND status = 'pending'")
    .run(orderId);
  if (result.changes <= 0) {
    return false;
  }

  logOrderEvent(db, {
    orderId,
    action: 'deleted',
    actorTelegramId,
    orderAmount: order.amount,
    clientPhone: order.client_phone,
    additionalPhone: order.additional_phone,
  });
  return true;
}

function deletePaidCashOrder(db: Db, orderId: any, actorTelegramId: any = null) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.status !== 'paid_cash') {
    return false;
  }

  const result = db
    .prepare("UPDATE orders SET status = 'deleted' WHERE id = ? AND status = 'paid_cash'")
    .run(orderId);
  if (result.changes <= 0) {
    return false;
  }

  logOrderEvent(db, {
    orderId,
    action: 'deleted',
    actorTelegramId,
    orderAmount: order.amount,
    clientPhone: order.client_phone,
    additionalPhone: order.additional_phone,
  });
  return true;
}

function markPendingOrderPaidCash(db: Db, orderId: any, actorTelegramId: any = null) {
  const { activateTechnicalSupportFromOrder } = (require('./technical-support') as typeof import('./technical-support'));
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.status !== 'pending') {
    return false;
  }

  const paymentTelegramId = actorTelegramId ?? order.telegram_id;
  if (paymentTelegramId == null) {
    return false;
  }

  db.exec('BEGIN');
  try {
    const result = db
      .prepare(
        `UPDATE orders
         SET status = 'paid_cash',
             payment_provider = 'cash',
             paid_at = datetime('now')
         WHERE id = ? AND status = 'pending'`
      )
      .run(orderId);
    if (result.changes <= 0) {
      db.exec('COMMIT');
      return false;
    }

    db.prepare(
      `INSERT INTO payments (
        order_id, telegram_id, amount, provider, click_trans_id,
        external_transaction_id, created_at
      ) VALUES (?, ?, ?, 'cash', NULL, NULL, datetime('now'))`
    ).run(orderId, paymentTelegramId, order.amount);

    const paidOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    activateTechnicalSupportFromOrder(db, paidOrder, { paidAt: paidOrder?.paid_at });

    logOrderEvent(db, {
      orderId,
      action: 'paid_cash',
      actorTelegramId,
      orderAmount: order.amount,
      clientPhone: order.client_phone,
      additionalPhone: order.additional_phone,
      paymentProvider: 'cash',
    });

    db.exec('COMMIT');
    return true;
  } catch (error: any) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  }
}

function getEarningsRows(db: Db, { telegramId = null, from = null, to = null }: Unchecked = {}) {
  let sql = `
    SELECT
      p.created_at AS paid_at,
      p.order_id,
      p.amount,
      o.currency,
      p.provider,
      o.client_phone,
      COALESCE(bu.display_name, bu.first_name, bu.username, '') AS employee_name,
      bu.phone AS employee_phone,
      p.telegram_id
    FROM payments p
    INNER JOIN orders o ON o.id = p.order_id
    LEFT JOIN bot_users bu ON bu.telegram_id = p.telegram_id
    WHERE 1 = 1
  `;
  const params: any[] = [];

  if (telegramId != null) {
    sql += ' AND p.telegram_id = ?';
    params.push(telegramId);
  }
  if (from) {
    sql += ' AND date(p.created_at) >= date(?)';
    params.push(from);
  }
  if (to) {
    sql += ' AND date(p.created_at) <= date(?)';
    params.push(to);
  }

  sql += ' ORDER BY datetime(p.created_at) DESC';
  return db.prepare(sql).all(...params);
}

export {
  getAllUnpaidOrders,
  deletePendingOrder,
  deletePaidCashOrder,
  markPendingOrderPaidCash,
  getEarningsRows,
};
