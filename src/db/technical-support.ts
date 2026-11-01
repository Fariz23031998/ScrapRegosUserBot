import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import {
  addCalendarMonths,
  toIsoUtc,
  durationDaysFromRange,
  computeEndsAt,
} from './technical-support-orders';
import { resolveListOrderBy } from './list-sort';

const ALLOWED_DURATIONS = [1, 3, 6, 12];
const PRODUCT_TYPE = 'technical_support';

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

function normalizePhoneKey(phone?: any) {
  return String(phone || '').replace(/\D/g, '');
}

function canonicalizeUzbekPhone(phone?: any) {
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

function isAllowedDuration(months?: any) {
  return ALLOWED_DURATIONS.includes(Number(months));
}

function tableExists(db: Db, name?: any) {
  return Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name)
  );
}

function columnExists(db: Db, table?: any, column?: any) {
  if (!tableExists(db, table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some((col?: any) => col.name === column);
}

function ensureTechnicalSupportTables(db: Db) {
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

function migrateLegacySubscriptions(db: Db) {
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
    .all() as {
      phone: string | null;
      phone_key: string | null;
      created_at: string | null;
      months: number | null;
      starts_at: string | null;
      ends_at: string | null;
      order_id: string | null;
      amount: number | null;
    }[];

  const insertSubscription = db.prepare(
    `INSERT INTO technical_support_subscriptions (phone, phone_key, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'))`
  );
  const insertOrder = db.prepare(
    `INSERT INTO technical_support_subscription_orders (
       subscription_id, order_id, months, duration_days, amount, starts_at, cancelled_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const subscriptionIds: Map<any, any> = new Map();

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
      let durationDays: any = null;
      let cancelledAt: any = null;
      if (months === 0) {
        durationDays = durationDaysFromRange(startsAt, row.ends_at);
      } else {
        const naturalEnd = addCalendarMonths(new Date(startsAt), months);
        const storedEndMs = Date.parse(row.ends_at!);
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
  } catch (error: any) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  }

  db.exec('DROP TABLE technical_support_subscriptions_legacy');
}

function seedDefaultPrices(db: Db) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO technical_support_prices (months, amount, updated_at)
     VALUES (?, 0, datetime('now'))`
  );
  for (const months of ALLOWED_DURATIONS) {
    insert.run(months);
  }
}

function listTechnicalSupportPrices(db: Db) {
  ensureTechnicalSupportTables(db);
  const rows = db
    .prepare(
      `SELECT months, amount, updated_at
       FROM technical_support_prices
       ORDER BY months ASC`
    )
    .all();

  const byMonths: Map<any, any> = new Map(rows.map((row?: any) => [Number(row.months), row]));
  return ALLOWED_DURATIONS.map((months?: any) => {
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

function getTechnicalSupportPrice(db: Db, months?: any) {
  const duration = Number(months);
  if (!isAllowedDuration(duration)) return null;
  return listTechnicalSupportPrices(db).find((row?: any) => row.months === duration) ?? null;
}

function updateTechnicalSupportPrices(db: Db, pricesInput: any = {}) {
  ensureTechnicalSupportTables(db);
  const updates: any[] = [];

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
  } catch (error: any) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  }

  return listTechnicalSupportPrices(db);
}



function parseOrderMetadata(order?: any) {
  if (!order?.metadata) return null;
  try {
    return typeof order.metadata === 'string' ? JSON.parse(order.metadata) : order.metadata;
  } catch {
    return null;
  }
}

function isTechnicalSupportOrder(order?: any) {
  const metadata = parseOrderMetadata(order);
  return Boolean(metadata && metadata.product_type === PRODUCT_TYPE);
}

function getTechnicalSupportOrderDetails(order?: any) {
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



function mapSubscriptionRow(row: any, { now = Date.now() }: Unchecked = {}) {
  if (!row) return null;
  const endsAt = computeEndsAt(row);
  const endsAtMs = Date.parse(endsAt!);
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
  db: Db,
  { query = '', status = '', offset = 0, limit = 25, sort }: Unchecked = {}
) {
  ensureTechnicalSupportTables(db);
  const normalizedQuery = String(query || '').trim();
  const statusFilter = String(status || '').trim().toLowerCase();
  const nowIso = new Date().toISOString();

  const where: any[] = [];
  const params: any[] = [];

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
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM technical_support_subscription_orders o
         INNER JOIN technical_support_subscriptions s ON s.id = o.subscription_id
         ${whereSql}`
      )
      .get(...params) as { count: number } | undefined
  )!.count;

  const orderBy =
    resolveListOrderBy(
      sort,
      {
        id: 'o.id',
        phone: 's.phone COLLATE NOCASE',
        months: 'o.months',
        amount: 'o.amount',
        order_id: 'o.order_id COLLATE NOCASE',
        starts_at: 'datetime(o.starts_at)',
        ends_at: `datetime(${COMPUTED_ENDS_AT_SQL})`,
        status: `CASE WHEN o.cancelled_at IS NULL AND datetime(${COMPUTED_ENDS_AT_SQL}) > datetime('now') THEN 0 ELSE 1 END`,
      },
      'o.id',
    ) || 'ORDER BY datetime(o.created_at) DESC, o.id DESC';
  const rows = db
    .prepare(
      `${ORDER_SELECT_SQL}
       ${whereSql}
       ${orderBy}
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  return {
    total,
    items: rows.map((row?: any) => mapSubscriptionRow(row)),
  };
}

function formatSupportUntilDate(endsAt?: any) {
  const date = new Date(endsAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function formatSupportUntilLabel(endsAt?: any) {
  const formatted = formatSupportUntilDate(endsAt);
  if (!formatted) return null;
  return `Есть платные подписки ТП\n📅 До: ${formatted}`;
}

export {
  ALLOWED_DURATIONS,
  PRODUCT_TYPE,
  ensureTechnicalSupportTables,
  listTechnicalSupportPrices,
  getTechnicalSupportPrice,
  updateTechnicalSupportPrices,
  isTechnicalSupportOrder,
  getTechnicalSupportOrderDetails,
  parseOrderMetadata,
  mapSubscriptionRow,
  normalizePhoneKey,
  canonicalizeUzbekPhone,
  listTechnicalSupportSubscriptions,
  formatSupportUntilLabel,
  formatSupportUntilDate,
};
export {
  addCalendarMonths,
  getActiveTechnicalSupportSubscription,
  getTechnicalSupportStatusByPhone,
  activateTechnicalSupportFromOrder,
  createManualTechnicalSupportSubscription,
  getTechnicalSupportSubscriptionById,
  deactivateTechnicalSupportSubscription,
  updateTechnicalSupportSubscriptionEndsAt,
  deleteTechnicalSupportSubscription,
} from './technical-support-orders';
