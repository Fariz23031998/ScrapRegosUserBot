const crypto = require('crypto');

const ALLOWED_DURATIONS = [1, 3, 6, 12];
const PRODUCT_TYPE = 'technical_support';
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

const COMPUTED_ENDS_AT_SQL = `
  CASE
    WHEN o.cancelled_at IS NOT NULL THEN o.cancelled_at
    WHEN COALESCE(o.months, 0) = 0 THEN datetime(o.starts_at, '+' || COALESCE(o.duration_days, 0) || ' days')
    ELSE datetime(o.starts_at, '+' || o.months || ' months')
  END
`;

function normalizePhoneKey(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function canonicalizeUzbekPhone(phone) {
  let digits = normalizePhoneKey(phone);
  if (!digits) return null;
  if (digits.length === 9 && digits.startsWith('9')) {
    digits = `998${digits}`;
  }
  if (digits.length === 12 && digits.startsWith('998')) {
    return { phone: `+${digits}`, phoneKey: digits };
  }
  return null;
}

function phonesMatch(storedPhone, queryPhone) {
  const stored = normalizePhoneKey(storedPhone);
  const query = normalizePhoneKey(queryPhone);
  if (!stored || !query) return false;
  if (stored === query) return true;
  if (stored.endsWith(query) || query.endsWith(stored)) return true;
  const storedTail = stored.slice(-9);
  const queryTail = query.slice(-9);
  return storedTail.length >= 9 && storedTail === queryTail;
}

function isAllowedDuration(months) {
  return ALLOWED_DURATIONS.includes(Number(months));
}

function tableExists(db, name) {
  return Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name)
  );
}

function columnExists(db, table, column) {
  if (!tableExists(db, table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some((col) => col.name === column);
}

function ensureTechnicalSupportTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS technical_support_prices (
      months INTEGER PRIMARY KEY,
      amount INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  migrateLegacySubscriptions(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS technical_support_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      phone_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS technical_support_subscription_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription_id INTEGER NOT NULL,
      order_id TEXT NOT NULL UNIQUE,
      months INTEGER NOT NULL,
      duration_days REAL,
      amount INTEGER NOT NULL,
      starts_at TEXT NOT NULL,
      cancelled_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (subscription_id) REFERENCES technical_support_subscriptions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_ts_subscriptions_phone_key
      ON technical_support_subscriptions(phone_key);
    CREATE INDEX IF NOT EXISTS idx_ts_subscription_orders_subscription_id
      ON technical_support_subscription_orders(subscription_id);
    CREATE INDEX IF NOT EXISTS idx_ts_subscription_orders_created_at
      ON technical_support_subscription_orders(created_at);
  `);

  seedDefaultPrices(db);
}

function migrateLegacySubscriptions(db) {
  if (!tableExists(db, 'technical_support_subscriptions')) return;
  if (!columnExists(db, 'technical_support_subscriptions', 'ends_at')) return;

  db.exec(
    'ALTER TABLE technical_support_subscriptions RENAME TO technical_support_subscriptions_legacy'
  );
  db.exec('DROP INDEX IF EXISTS idx_ts_subscriptions_phone_key');
  db.exec('DROP INDEX IF EXISTS idx_ts_subscriptions_ends_at');

  db.exec(`
    CREATE TABLE technical_support_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      phone_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS technical_support_subscription_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription_id INTEGER NOT NULL,
      order_id TEXT NOT NULL UNIQUE,
      months INTEGER NOT NULL,
      duration_days REAL,
      amount INTEGER NOT NULL,
      starts_at TEXT NOT NULL,
      cancelled_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (subscription_id) REFERENCES technical_support_subscriptions(id)
    );
  `);

  const legacyRows = db
    .prepare(
      `SELECT *
       FROM technical_support_subscriptions_legacy
       ORDER BY datetime(created_at) ASC, id ASC`
    )
    .all();

  const insertSubscription = db.prepare(
    `INSERT INTO technical_support_subscriptions (phone, phone_key, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'))`
  );
  const insertOrder = db.prepare(
    `INSERT INTO technical_support_subscription_orders (
       subscription_id, order_id, months, duration_days, amount, starts_at, cancelled_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const subscriptionIds = new Map();

  db.exec('BEGIN');
  try {
    for (const row of legacyRows) {
      const canonical =
        canonicalizeUzbekPhone(row.phone) || canonicalizeUzbekPhone(row.phone_key);
      const phoneKey = canonical?.phoneKey || normalizePhoneKey(row.phone_key || row.phone);
      const phone = canonical?.phone || String(row.phone || '').trim() || phoneKey;
      if (!phoneKey) continue;

      let subscriptionId = subscriptionIds.get(phoneKey);
      if (!subscriptionId) {
        const existing = db
          .prepare('SELECT id FROM technical_support_subscriptions WHERE phone_key = ?')
          .get(phoneKey);
        if (existing) {
          subscriptionId = existing.id;
        } else {
          const created = insertSubscription.run(phone, phoneKey, row.created_at || toIsoUtc(new Date()));
          subscriptionId = created.lastInsertRowid;
        }
        subscriptionIds.set(phoneKey, subscriptionId);
      }

      const months = Number(row.months) || 0;
      const startsAt = row.starts_at || toIsoUtc(new Date());
      let durationDays = null;
      let cancelledAt = null;
      if (months === 0) {
        durationDays = durationDaysFromRange(startsAt, row.ends_at);
      } else {
        const naturalEnd = addCalendarMonths(new Date(startsAt), months);
        const storedEndMs = Date.parse(row.ends_at);
        if (Number.isFinite(storedEndMs) && storedEndMs + 1000 < naturalEnd.getTime()) {
          cancelledAt = row.ends_at;
        }
      }

      insertOrder.run(
        subscriptionId,
        row.order_id,
        months,
        durationDays,
        Number(row.amount) || 0,
        startsAt,
        cancelledAt,
        row.created_at || startsAt
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  }

  db.exec('DROP TABLE technical_support_subscriptions_legacy');
}

function seedDefaultPrices(db) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO technical_support_prices (months, amount, updated_at)
     VALUES (?, 0, datetime('now'))`
  );
  for (const months of ALLOWED_DURATIONS) {
    insert.run(months);
  }
}

function listTechnicalSupportPrices(db) {
  ensureTechnicalSupportTables(db);
  const rows = db
    .prepare(
      `SELECT months, amount, updated_at
       FROM technical_support_prices
       ORDER BY months ASC`
    )
    .all();

  const byMonths = new Map(rows.map((row) => [Number(row.months), row]));
  return ALLOWED_DURATIONS.map((months) => {
    const row = byMonths.get(months);
    const amount = Number(row?.amount || 0);
    return {
      months,
      amount,
      configured: amount > 0,
      updated_at: row?.updated_at ?? null,
    };
  });
}

function getTechnicalSupportPrice(db, months) {
  const duration = Number(months);
  if (!isAllowedDuration(duration)) return null;
  return listTechnicalSupportPrices(db).find((row) => row.months === duration) ?? null;
}

function updateTechnicalSupportPrices(db, pricesInput = {}) {
  ensureTechnicalSupportTables(db);
  const updates = [];

  for (const months of ALLOWED_DURATIONS) {
    const key = String(months);
    if (pricesInput[key] === undefined && pricesInput[months] === undefined) {
      continue;
    }
    const raw = pricesInput[key] ?? pricesInput[months];
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount < 0 || !Number.isInteger(amount)) {
      throw new Error('INVALID_AMOUNT');
    }
    updates.push({ months, amount });
  }

  if (updates.length === 0) {
    throw new Error('NO_PRICES');
  }

  const stmt = db.prepare(
    `UPDATE technical_support_prices
     SET amount = ?, updated_at = datetime('now')
     WHERE months = ?`
  );
  db.exec('BEGIN');
  try {
    for (const item of updates) {
      stmt.run(item.amount, item.months);
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  }

  return listTechnicalSupportPrices(db);
}

function addCalendarMonths(date, months) {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCMonth(result.getUTCMonth() + Number(months));
  // Handle month overflow (e.g. Jan 31 + 1 month)
  if (result.getUTCDate() < day) {
    result.setUTCDate(0);
  }
  return result;
}

function addDurationDays(date, days) {
  return new Date(date.getTime() + Number(days) * MS_PER_DAY);
}

function toIsoUtc(date) {
  return new Date(date).toISOString();
}

function durationDaysFromRange(startsAt, endsAt) {
  const startMs = Date.parse(startsAt);
  const endMs = Date.parse(endsAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, (endMs - startMs) / MS_PER_DAY);
}

function computeEndsAtDate(row) {
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

function computeEndsAt(row) {
  const date = computeEndsAtDate(row);
  if (Number.isNaN(date.getTime())) return null;
  return toIsoUtc(date);
}

function parseOrderMetadata(order) {
  if (!order?.metadata) return null;
  try {
    return typeof order.metadata === 'string' ? JSON.parse(order.metadata) : order.metadata;
  } catch {
    return null;
  }
}

function isTechnicalSupportOrder(order) {
  const metadata = parseOrderMetadata(order);
  return Boolean(metadata && metadata.product_type === PRODUCT_TYPE);
}

function getTechnicalSupportOrderDetails(order) {
  if (!isTechnicalSupportOrder(order)) return null;
  const metadata = parseOrderMetadata(order);
  const months = Number(metadata.months);
  if (!isAllowedDuration(months)) return null;
  return {
    months,
    amount: Number(order.amount),
    phone: order.client_phone,
    metadata,
  };
}

function findSubscriptionByPhoneKey(db, phoneKey) {
  if (!phoneKey) return null;
  const exact = db
    .prepare('SELECT * FROM technical_support_subscriptions WHERE phone_key = ?')
    .get(phoneKey);
  if (exact) return exact;

  const tail = phoneKey.slice(-9);
  const candidates = db
    .prepare('SELECT * FROM technical_support_subscriptions WHERE phone_key LIKE ?')
    .all(`%${tail}`);
  return candidates.find((row) => phonesMatch(row.phone_key, phoneKey)) || null;
}

function upsertSubscriptionForPhone(db, canonical) {
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

function touchSubscription(db, subscriptionId) {
  db.prepare(
    `UPDATE technical_support_subscriptions SET updated_at = datetime('now') WHERE id = ?`
  ).run(subscriptionId);
}

function parseActivationTime(value) {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) return new Date();
  return parsed;
}

function restackSubscriptionOrders(db, subscriptionId) {
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
  let previousEnd = null;
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

function getSubscriptionOrderById(db, id) {
  const orderId = Number(id);
  if (!Number.isInteger(orderId) || orderId <= 0) return null;
  return db.prepare(`${ORDER_SELECT_SQL} WHERE o.id = ?`).get(orderId) || null;
}

function getSubscriptionOrderByExternalId(db, orderId) {
  return db.prepare(`${ORDER_SELECT_SQL} WHERE o.order_id = ?`).get(orderId) || null;
}

function listOrdersForPhoneLookup(db, phone) {
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
    (row) => phonesMatch(row.phone_key, lookupKey) || phonesMatch(row.phone, phone)
  );
}

function getActiveTechnicalSupportSubscription(db, phone) {
  ensureTechnicalSupportTables(db);
  const now = Date.now();
  const mapped = listOrdersForPhoneLookup(db, phone)
    .map((row) => mapSubscriptionRow(row, { now }))
    .filter((row) => row.status === 'active')
    .sort((a, b) => Date.parse(b.ends_at) - Date.parse(a.ends_at));
  return mapped[0] || null;
}

/**
 * Latest technical-support coverage for a phone, whether active or expired.
 * Returns { status: 'active'|'expired'|'none', ends_at, starts_at, subscription }.
 */
function getTechnicalSupportStatusByPhone(db, phone, { now = Date.now() } = {}) {
  ensureTechnicalSupportTables(db);
  const mapped = listOrdersForPhoneLookup(db, phone).map((row) => mapSubscriptionRow(row, { now }));
  if (mapped.length === 0) {
    return { status: 'none', ends_at: null, starts_at: null, subscription: null };
  }

  const active = mapped
    .filter((row) => row.status === 'active')
    .sort((a, b) => Date.parse(b.ends_at) - Date.parse(a.ends_at));
  const latest = active[0] || mapped.sort((a, b) => Date.parse(b.ends_at) - Date.parse(a.ends_at))[0];
  return {
    status: latest.status,
    ends_at: latest.ends_at,
    starts_at: latest.starts_at,
    subscription: latest,
  };
}

function insertSubscriptionOrder(
  db,
  { subscriptionId, orderId, months, durationDays, amount, activationTime }
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
function activateTechnicalSupportFromOrder(db, order, { paidAt = null } = {}) {
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
  db,
  { phone, months, amount = 0, ends_at: endsAtInput = null } = {}
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
  let durationDays = null;
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

function previewStackedStart(db, subscriptionId, activationTime) {
  const orders = db
    .prepare(
      `SELECT *
       FROM technical_support_subscription_orders
       WHERE subscription_id = ? AND cancelled_at IS NULL
       ORDER BY datetime(created_at) ASC, id ASC`
    )
    .all(subscriptionId);

  let previousEnd = null;
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

function getTechnicalSupportSubscriptionById(db, id) {
  ensureTechnicalSupportTables(db);
  return getSubscriptionOrderById(db, id);
}

/**
 * End an active subscription order immediately by setting cancelled_at to now.
 * Already-expired rows are left unchanged (changed: false).
 */
function deactivateTechnicalSupportSubscription(db, id) {
  ensureTechnicalSupportTables(db);
  const row = getTechnicalSupportSubscriptionById(db, id);
  if (!row) {
    throw new Error('NOT_FOUND');
  }

  const mapped = mapSubscriptionRow(row);
  if (mapped.status !== 'active') {
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

function updateTechnicalSupportSubscriptionEndsAt(db, id, endsAt) {
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

function deleteTechnicalSupportSubscription(db, id) {
  ensureTechnicalSupportTables(db);
  const row = getTechnicalSupportSubscriptionById(db, id);
  if (!row) {
    throw new Error('NOT_FOUND');
  }

  const result = db
    .prepare('DELETE FROM technical_support_subscription_orders WHERE id = ?')
    .run(row.id);
  const remaining = db
    .prepare(
      'SELECT COUNT(*) AS count FROM technical_support_subscription_orders WHERE subscription_id = ?'
    )
    .get(row.subscription_id).count;
  if (remaining === 0) {
    db.prepare('DELETE FROM technical_support_subscriptions WHERE id = ?').run(row.subscription_id);
  } else {
    restackSubscriptionOrders(db, row.subscription_id);
  }
  return { deleted: result.changes > 0, id: row.id };
}

function mapSubscriptionRow(row, { now = Date.now() } = {}) {
  if (!row) return null;
  const endsAt = computeEndsAt(row);
  const endsAtMs = Date.parse(endsAt);
  const active = Number.isFinite(endsAtMs) && endsAtMs > now;
  return {
    id: row.id,
    subscription_id: row.subscription_id ?? null,
    phone: row.phone,
    phone_key: row.phone_key,
    order_id: row.order_id,
    months: Number(row.months),
    duration_days: row.duration_days == null ? null : Number(row.duration_days),
    amount: Number(row.amount),
    starts_at: row.starts_at,
    ends_at: endsAt,
    cancelled_at: row.cancelled_at ?? null,
    created_at: row.created_at,
    status: active ? 'active' : 'expired',
    status_label: active ? 'Активна' : 'Истекла',
  };
}

function listTechnicalSupportSubscriptions(
  db,
  { query = '', status = '', offset = 0, limit = 25 } = {}
) {
  ensureTechnicalSupportTables(db);
  const normalizedQuery = String(query || '').trim();
  const statusFilter = String(status || '').trim().toLowerCase();
  const nowIso = new Date().toISOString();

  const where = [];
  const params = [];

  if (normalizedQuery) {
    const like = `%${normalizedQuery}%`;
    const digits = normalizePhoneKey(normalizedQuery);
    where.push('(s.phone LIKE ? OR o.order_id LIKE ? OR s.phone_key LIKE ?)');
    params.push(like, like, digits ? `%${digits}%` : like);
  }

  if (statusFilter === 'active') {
    where.push(`o.cancelled_at IS NULL AND datetime(${COMPUTED_ENDS_AT_SQL}) > datetime(?)`);
    params.push(nowIso);
  } else if (statusFilter === 'expired') {
    where.push(`(o.cancelled_at IS NOT NULL OR datetime(${COMPUTED_ENDS_AT_SQL}) <= datetime(?))`);
    params.push(nowIso);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM technical_support_subscription_orders o
       INNER JOIN technical_support_subscriptions s ON s.id = o.subscription_id
       ${whereSql}`
    )
    .get(...params).count;

  const rows = db
    .prepare(
      `${ORDER_SELECT_SQL}
       ${whereSql}
       ORDER BY datetime(o.created_at) DESC, o.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  return {
    total,
    items: rows.map((row) => mapSubscriptionRow(row)),
  };
}

function formatSupportUntilDate(endsAt) {
  const date = new Date(endsAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function formatSupportUntilLabel(endsAt) {
  const formatted = formatSupportUntilDate(endsAt);
  if (!formatted) return null;
  return `Есть платные подписки ТП\n📅 До: ${formatted}`;
}

module.exports = {
  ALLOWED_DURATIONS,
  PRODUCT_TYPE,
  ensureTechnicalSupportTables,
  listTechnicalSupportPrices,
  getTechnicalSupportPrice,
  updateTechnicalSupportPrices,
  getActiveTechnicalSupportSubscription,
  getTechnicalSupportStatusByPhone,
  activateTechnicalSupportFromOrder,
  createManualTechnicalSupportSubscription,
  getTechnicalSupportSubscriptionById,
  deactivateTechnicalSupportSubscription,
  updateTechnicalSupportSubscriptionEndsAt,
  deleteTechnicalSupportSubscription,
  listTechnicalSupportSubscriptions,
  isTechnicalSupportOrder,
  getTechnicalSupportOrderDetails,
  parseOrderMetadata,
  mapSubscriptionRow,
  addCalendarMonths,
  normalizePhoneKey,
  canonicalizeUzbekPhone,
  formatSupportUntilLabel,
  formatSupportUntilDate,
};
