const ALLOWED_DURATIONS = [1, 3, 6, 12];
const PRODUCT_TYPE = 'technical_support';

function normalizePhoneKey(phone) {
  return String(phone || '').replace(/\D/g, '');
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

function ensureTechnicalSupportTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS technical_support_prices (
      months INTEGER PRIMARY KEY,
      amount INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS technical_support_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      phone_key TEXT NOT NULL,
      order_id TEXT NOT NULL UNIQUE,
      months INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ts_subscriptions_phone_key
      ON technical_support_subscriptions(phone_key);
    CREATE INDEX IF NOT EXISTS idx_ts_subscriptions_ends_at
      ON technical_support_subscriptions(ends_at);
  `);

  seedDefaultPrices(db);
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

function toIsoUtc(date) {
  return new Date(date).toISOString();
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

function getActiveTechnicalSupportSubscription(db, phone) {
  ensureTechnicalSupportTables(db);
  const phoneKey = normalizePhoneKey(phone);
  if (!phoneKey) return null;

  const nowIso = new Date().toISOString();
  const tail = phoneKey.slice(-9);
  const candidates = db
    .prepare(
      `SELECT *
       FROM technical_support_subscriptions
       WHERE datetime(ends_at) > datetime(?)
         AND (phone_key = ? OR phone_key LIKE ?)
       ORDER BY datetime(ends_at) DESC`
    )
    .all(nowIso, phoneKey, `%${tail}`);

  for (const row of candidates) {
    if (phonesMatch(row.phone_key, phoneKey) || phonesMatch(row.phone, phone)) {
      return row;
    }
  }
  return null;
}

function getLatestTechnicalSupportEnd(db, phoneKey) {
  const row = db
    .prepare(
      `SELECT ends_at
       FROM technical_support_subscriptions
       WHERE phone_key = ?
       ORDER BY datetime(ends_at) DESC
       LIMIT 1`
    )
    .get(phoneKey);
  return row?.ends_at ?? null;
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

  const existing = db
    .prepare('SELECT * FROM technical_support_subscriptions WHERE order_id = ?')
    .get(order.id);
  if (existing) {
    return { created: false, subscription: existing, reason: 'already_activated' };
  }

  const phone = String(details.phone || '').trim();
  const phoneKey = normalizePhoneKey(phone);
  if (!phoneKey) {
    return { created: false, subscription: null, reason: 'missing_phone' };
  }

  let paymentTime = paidAt ? new Date(paidAt) : new Date();
  if (Number.isNaN(paymentTime.getTime())) {
    paymentTime = new Date();
  }

  const latestEnd = getLatestTechnicalSupportEnd(db, phoneKey);
  const latestEndMs = latestEnd ? Date.parse(latestEnd) : NaN;
  const startBase =
    Number.isFinite(latestEndMs) && latestEndMs > paymentTime.getTime()
      ? new Date(latestEndMs)
      : paymentTime;
  const endsAt = addCalendarMonths(startBase, details.months);

  const result = db
    .prepare(
      `INSERT INTO technical_support_subscriptions (
         phone, phone_key, order_id, months, amount, starts_at, ends_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .run(
      phone,
      phoneKey,
      order.id,
      details.months,
      details.amount,
      toIsoUtc(startBase),
      toIsoUtc(endsAt)
    );

  const subscription = db
    .prepare('SELECT * FROM technical_support_subscriptions WHERE id = ?')
    .get(result.lastInsertRowid);

  return { created: true, subscription };
}

function mapSubscriptionRow(row, { now = Date.now() } = {}) {
  if (!row) return null;
  const endsAtMs = Date.parse(row.ends_at);
  const active = Number.isFinite(endsAtMs) && endsAtMs > now;
  return {
    id: row.id,
    phone: row.phone,
    phone_key: row.phone_key,
    order_id: row.order_id,
    months: Number(row.months),
    amount: Number(row.amount),
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    created_at: row.created_at,
    status: active ? 'active' : 'expired',
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
    where.push('(phone LIKE ? OR order_id LIKE ? OR phone_key LIKE ?)');
    params.push(like, like, digits ? `%${digits}%` : like);
  }

  if (statusFilter === 'active') {
    where.push('datetime(ends_at) > datetime(?)');
    params.push(nowIso);
  } else if (statusFilter === 'expired') {
    where.push('datetime(ends_at) <= datetime(?)');
    params.push(nowIso);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db
    .prepare(`SELECT COUNT(*) AS count FROM technical_support_subscriptions ${whereSql}`)
    .get(...params).count;

  const rows = db
    .prepare(
      `SELECT *
       FROM technical_support_subscriptions
       ${whereSql}
       ORDER BY datetime(created_at) DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  return {
    total,
    items: rows.map((row) => mapSubscriptionRow(row)),
  };
}

function formatSupportUntilLabel(endsAt) {
  const date = new Date(endsAt);
  if (Number.isNaN(date.getTime())) return null;
  return 'Есть платные подписки ТП';
}

module.exports = {
  ALLOWED_DURATIONS,
  PRODUCT_TYPE,
  ensureTechnicalSupportTables,
  listTechnicalSupportPrices,
  getTechnicalSupportPrice,
  updateTechnicalSupportPrices,
  getActiveTechnicalSupportSubscription,
  activateTechnicalSupportFromOrder,
  listTechnicalSupportSubscriptions,
  isTechnicalSupportOrder,
  getTechnicalSupportOrderDetails,
  parseOrderMetadata,
  mapSubscriptionRow,
  addCalendarMonths,
  normalizePhoneKey,
  formatSupportUntilLabel,
};
