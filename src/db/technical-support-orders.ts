import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import crypto from 'crypto';
import {
  ALLOWED_DURATIONS,
  PRODUCT_TYPE,
  ensureTechnicalSupportTables,
  normalizePhoneKey,
  canonicalizeUzbekPhone,
  getTechnicalSupportOrderDetails,
  mapSubscriptionRow,
} from './technical-support';

function phonesMatch(storedPhone?: any, queryPhone?: any) {
  const stored = normalizePhoneKey(storedPhone);
  const query = normalizePhoneKey(queryPhone);
  if (!stored || !query) return false;
  if (stored === query) return true;
  if (stored.endsWith(query) || query.endsWith(stored)) return true;
  const storedTail = stored.slice(-9);
  const queryTail = query.slice(-9);
  return storedTail.length >= 9 && storedTail === queryTail;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ORDER_SELECT_SQL = `
  SELECT
    o.id,
    o.subscription_id,
    o.order_id,
    o.months,
    o.duration_days,
    o.amount,
    o.starts_at,
    o.cancelled_at,
    o.created_at,
    s.phone,
    s.phone_key
  FROM technical_support_subscription_orders o
  INNER JOIN technical_support_subscriptions s ON s.id = o.subscription_id
`;

function isAllowedDuration(months?: any) {
  return ALLOWED_DURATIONS.includes(Number(months));
}

function addCalendarMonths(date?: any, months?: any) {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCMonth(result.getUTCMonth() + Number(months));
  // Handle month overflow (e.g. Jan 31 + 1 month)
  if (result.getUTCDate() < day) {
    result.setUTCDate(0);
  }
  return result;
}

function addDurationDays(date?: any, days?: any) {
  return new Date(date.getTime() + Number(days) * MS_PER_DAY);
}

function toIsoUtc(date?: any) {
  return new Date(date).toISOString();
}

function durationDaysFromRange(startsAt?: any, endsAt?: any) {
  const startMs = Date.parse(startsAt);
  const endMs = Date.parse(endsAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, (endMs - startMs) / MS_PER_DAY);
}

function computeEndsAtDate(row?: any) {
  if (row?.cancelled_at) {
    const cancelled = new Date(row.cancelled_at);
    if (!Number.isNaN(cancelled.getTime())) return cancelled;
  }
  const start = new Date(row?.starts_at);
  if (Number.isNaN(start.getTime())) return new Date(NaN);
  if (Number(row.months) === 0) {
    return addDurationDays(start, Number(row.duration_days || 0));
  }
  return addCalendarMonths(start, Number(row.months));
}

function computeEndsAt(row?: any) {
  const date = computeEndsAtDate(row);
  if (Number.isNaN(date.getTime())) return null;
  return toIsoUtc(date);
}

function findSubscriptionByPhoneKey(db: Db, phoneKey?: any) {
  if (!phoneKey) return null;
  const exact = db
    .prepare('SELECT * FROM technical_support_subscriptions WHERE phone_key = ?')
    .get(phoneKey);
  if (exact) return exact;

  const tail = phoneKey.slice(-9);
  const candidates = db
    .prepare('SELECT * FROM technical_support_subscriptions WHERE phone_key LIKE ?')
    .all(`%${tail}`);
  return candidates.find((row?: any) => phonesMatch(row.phone_key, phoneKey)) || null;
}

function upsertSubscriptionForPhone(db: Db, canonical?: any) {
  const existing = findSubscriptionByPhoneKey(db, canonical.phoneKey);
  if (existing) {
    if (existing.phone !== canonical.phone || existing.phone_key !== canonical.phoneKey) {
      db.prepare(
        `UPDATE technical_support_subscriptions
         SET phone = ?, phone_key = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(canonical.phone, canonical.phoneKey, existing.id);
    }
    return existing.id;
  }

  const result = db
    .prepare(
      `INSERT INTO technical_support_subscriptions (phone, phone_key, created_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))`
    )
    .run(canonical.phone, canonical.phoneKey);
  return result.lastInsertRowid;
}

function touchSubscription(db: Db, subscriptionId?: any) {
  db.prepare(
    `UPDATE technical_support_subscriptions SET updated_at = datetime('now') WHERE id = ?`
  ).run(subscriptionId);
}

function parseActivationTime(value?: any) {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) return new Date();
  return parsed;
}

function restackSubscriptionOrders(db: Db, subscriptionId?: any) {
  const orders = db
    .prepare(
      `SELECT *
       FROM technical_support_subscription_orders
       WHERE subscription_id = ? AND cancelled_at IS NULL
       ORDER BY datetime(created_at) ASC, id ASC`
    )
    .all(subscriptionId);

  const update = db.prepare(
    `UPDATE technical_support_subscription_orders SET starts_at = ? WHERE id = ?`
  );
  let previousEnd: any = null;
  for (const order of orders) {
    const activation = parseActivationTime(order.created_at);
    const start =
      previousEnd && previousEnd.getTime() > activation.getTime() ? previousEnd : activation;
    const startIso = toIsoUtc(start);
    if (startIso !== order.starts_at) {
      update.run(startIso, order.id);
      order.starts_at = startIso;
    }
    previousEnd = computeEndsAtDate(order);
  }
  touchSubscription(db, subscriptionId);
}

function getSubscriptionOrderById(db: Db, id?: any) {
  const orderId = Number(id);
  if (!Number.isInteger(orderId) || orderId <= 0) return null;
  return (db.prepare(`${ORDER_SELECT_SQL} WHERE o.id = ?`).get(orderId) as { starts_at: string; [key: string]: any } | undefined) || null;
}

function getSubscriptionOrderByExternalId(db: Db, orderId?: any) {
  return db.prepare(`${ORDER_SELECT_SQL} WHERE o.order_id = ?`).get(orderId) || null;
}

function listOrdersForPhoneLookup(db: Db, phone?: any) {
  const phoneKey = normalizePhoneKey(phone);
  if (!phoneKey) return [];
  const canonical = canonicalizeUzbekPhone(phone);
  const lookupKey = canonical?.phoneKey || phoneKey;
  const tail = lookupKey.slice(-9);
  const candidates = db
    .prepare(
      `${ORDER_SELECT_SQL}
       WHERE s.phone_key = ? OR s.phone_key LIKE ?
       ORDER BY datetime(o.created_at) DESC, o.id DESC`
    )
    .all(lookupKey, `%${tail}`);
  return candidates.filter(
    (row?: any) => phonesMatch(row.phone_key, lookupKey) || phonesMatch(row.phone, phone)
  );
}

function getActiveTechnicalSupportSubscription(db: Db, phone?: any) {
  ensureTechnicalSupportTables(db);
  const now = Date.now();
  const mapped = listOrdersForPhoneLookup(db, phone)
    .map((row?: any) => mapSubscriptionRow(row, { now }))
    .filter((row?: any) => row.status === 'active')
    .sort((a?: any, b?: any) => Date.parse(b.ends_at) - Date.parse(a.ends_at));
  return mapped[0] || null;
}

/**
 * Latest technical-support coverage for a phone, whether active or expired.
 * Returns { status: 'active'|'expired'|'none', ends_at, starts_at, subscription }.
 */
function getTechnicalSupportStatusByPhone(db: Db, phone: any, { now = Date.now() }: Unchecked = {}) {
  ensureTechnicalSupportTables(db);
  const mapped = listOrdersForPhoneLookup(db, phone).map((row?: any) => mapSubscriptionRow(row, { now }));
  if (mapped.length === 0) {
    return { status: 'none', ends_at: null, starts_at: null, subscription: null };
  }

  const active = mapped
    .filter((row?: any) => row.status === 'active')
    .sort((a?: any, b?: any) => Date.parse(b.ends_at) - Date.parse(a.ends_at));
  const latest = active[0] || mapped.sort((a?: any, b?: any) => Date.parse(b.ends_at) - Date.parse(a.ends_at))[0];
  return {
    status: latest!.status,
    ends_at: latest!.ends_at,
    starts_at: latest!.starts_at,
    subscription: latest,
  };
}

function insertSubscriptionOrder(
  db: Db,
  { subscriptionId, orderId, months, durationDays, amount, activationTime }: Unchecked
) {
  const activationIso = toIsoUtc(activationTime);
  const result = db
    .prepare(
      `INSERT INTO technical_support_subscription_orders (
         subscription_id, order_id, months, duration_days, amount, starts_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      subscriptionId,
      orderId,
      months,
      durationDays,
      amount,
      activationIso,
      activationIso
    );
  restackSubscriptionOrders(db, subscriptionId);
  return getSubscriptionOrderById(db, result.lastInsertRowid);
}

/**
 * Activate coverage for a paid technical-support order.
 * Idempotent via unique order_id. Returns { created, subscription }.
 */
function activateTechnicalSupportFromOrder(db: Db, order: any, { paidAt = null }: Unchecked = {}) {
  ensureTechnicalSupportTables(db);
  const details = getTechnicalSupportOrderDetails(order);
  if (!details) {
    return { created: false, subscription: null, reason: 'not_technical_support' };
  }

  const existing = getSubscriptionOrderByExternalId(db, order.id);
  if (existing) {
    return {
      created: false,
      subscription: mapSubscriptionRow(existing),
      reason: 'already_activated',
    };
  }

  const canonical = canonicalizeUzbekPhone(details.phone);
  if (!canonical) {
    return { created: false, subscription: null, reason: 'missing_phone' };
  }

  const subscriptionId = upsertSubscriptionForPhone(db, canonical);
  const row = insertSubscriptionOrder(db, {
    subscriptionId,
    orderId: order.id,
    months: details.months,
    durationDays: null,
    amount: details.amount,
    activationTime: parseActivationTime(paidAt),
  });

  return { created: true, subscription: mapSubscriptionRow(row) };
}

/**
 * Manually create a subscription order without a paid order.
 * Stacks after the latest computed end for the same phone.
 * Custom ends_at is converted to duration_days and never stored.
 */
function createManualTechnicalSupportSubscription(
  db: Db,
  { phone, months, amount = 0, ends_at: endsAtInput = null }: Unchecked = {}
) {
  ensureTechnicalSupportTables(db);

  const canonical = canonicalizeUzbekPhone(phone);
  if (!canonical) {
    throw new Error('INVALID_PHONE');
  }

  const hasCustomEnd =
    endsAtInput !== undefined && endsAtInput !== null && String(endsAtInput).trim() !== '';
  const duration = Number(months);

  if (!hasCustomEnd && !isAllowedDuration(duration)) {
    throw new Error('INVALID_MONTHS');
  }

  const amountValue = amount === undefined || amount === null || amount === '' ? 0 : Number(amount);
  if (!Number.isFinite(amountValue) || amountValue < 0 || !Number.isInteger(amountValue)) {
    throw new Error('INVALID_AMOUNT');
  }

  const now = new Date();
  let storedMonths = duration;
  let durationDays: any = null;
  const subscriptionId = upsertSubscriptionForPhone(db, canonical);

  if (hasCustomEnd) {
    const parsedEnd = new Date(endsAtInput);
    if (Number.isNaN(parsedEnd.getTime())) {
      throw new Error('INVALID_ENDS_AT');
    }
    const stackedStart = previewStackedStart(db, subscriptionId, now);
    if (parsedEnd.getTime() <= stackedStart.getTime()) {
      throw new Error('INVALID_ENDS_AT');
    }
    storedMonths = 0;
    durationDays = durationDaysFromRange(toIsoUtc(stackedStart), toIsoUtc(parsedEnd));
  }

  const row = insertSubscriptionOrder(db, {
    subscriptionId,
    orderId: `manual:${crypto.randomUUID()}`,
    months: storedMonths,
    durationDays,
    amount: amountValue,
    activationTime: now,
  });

  return { created: true, subscription: mapSubscriptionRow(row) };
}

function previewStackedStart(db: Db, subscriptionId?: any, activationTime?: any) {
  const orders = db
    .prepare(
      `SELECT *
       FROM technical_support_subscription_orders
       WHERE subscription_id = ? AND cancelled_at IS NULL
       ORDER BY datetime(created_at) ASC, id ASC`
    )
    .all(subscriptionId);

  let previousEnd: any = null;
  for (const order of orders) {
    const activation = parseActivationTime(order.created_at);
    const start =
      previousEnd && previousEnd.getTime() > activation.getTime() ? previousEnd : activation;
    previousEnd = computeEndsAtDate({ ...order, starts_at: toIsoUtc(start) });
  }
  if (previousEnd && previousEnd.getTime() > activationTime.getTime()) {
    return previousEnd;
  }
  return activationTime;
}

function getTechnicalSupportSubscriptionById(db: Db, id?: any) {
  ensureTechnicalSupportTables(db);
  return getSubscriptionOrderById(db, id);
}

/**
 * End an active subscription order immediately by setting cancelled_at to now.
 * Already-expired rows are left unchanged (changed: false).
 */
function deactivateTechnicalSupportSubscription(db: Db, id?: any) {
  ensureTechnicalSupportTables(db);
  const row = getTechnicalSupportSubscriptionById(db, id);
  if (!row) {
    throw new Error('NOT_FOUND');
  }

  const mapped = mapSubscriptionRow(row);
  if (mapped!.status !== 'active') {
    return { changed: false, reason: 'already_expired', subscription: mapped };
  }

  const cancelledAt = toIsoUtc(new Date());
  db.prepare(
    `UPDATE technical_support_subscription_orders SET cancelled_at = ? WHERE id = ?`
  ).run(cancelledAt, row.id);
  restackSubscriptionOrders(db, row.subscription_id);

  return {
    changed: true,
    subscription: mapSubscriptionRow(getTechnicalSupportSubscriptionById(db, row.id)),
  };
}

function updateTechnicalSupportSubscriptionEndsAt(db: Db, id?: any, endsAt?: any) {
  ensureTechnicalSupportTables(db);
  const row = getTechnicalSupportSubscriptionById(db, id);
  if (!row) {
    throw new Error('NOT_FOUND');
  }

  const parsed = new Date(endsAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('INVALID_ENDS_AT');
  }

  const start = new Date(row.starts_at);
  if (Number.isNaN(start.getTime())) {
    throw new Error('INVALID_ENDS_AT');
  }

  const durationDays = durationDaysFromRange(row.starts_at, toIsoUtc(parsed));
  db.prepare(
    `UPDATE technical_support_subscription_orders
     SET months = 0, duration_days = ?, cancelled_at = NULL
     WHERE id = ?`
  ).run(durationDays, row.id);
  restackSubscriptionOrders(db, row.subscription_id);

  return {
    subscription: mapSubscriptionRow(getTechnicalSupportSubscriptionById(db, row.id)),
  };
}

function deleteTechnicalSupportSubscription(db: Db, id?: any) {
  ensureTechnicalSupportTables(db);
  const row = getTechnicalSupportSubscriptionById(db, id);
  if (!row) {
    throw new Error('NOT_FOUND');
  }

  const result = db
    .prepare('DELETE FROM technical_support_subscription_orders WHERE id = ?')
    .run(row.id);
  const remaining = (
    db
      .prepare(
        'SELECT COUNT(*) AS count FROM technical_support_subscription_orders WHERE subscription_id = ?'
      )
      .get(row.subscription_id) as { count: number } | undefined
  )!.count;
  if (remaining === 0) {
    db.prepare('DELETE FROM technical_support_subscriptions WHERE id = ?').run(row.subscription_id);
  } else {
    restackSubscriptionOrders(db, row.subscription_id);
  }
  return { deleted: result.changes > 0, id: row.id };
}

export {
  addCalendarMonths,
  toIsoUtc,
  durationDaysFromRange,
  computeEndsAt,
  getActiveTechnicalSupportSubscription,
  getTechnicalSupportStatusByPhone,
  activateTechnicalSupportFromOrder,
  createManualTechnicalSupportSubscription,
  getTechnicalSupportSubscriptionById,
  deactivateTechnicalSupportSubscription,
  updateTechnicalSupportSubscriptionEndsAt,
  deleteTechnicalSupportSubscription,
};
