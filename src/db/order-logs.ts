import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { resolveListOrderBy } from './list-sort';

function ensureOrderLogsTable(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_telegram_id INTEGER,
      actor_phone TEXT,
      actor_name TEXT,
      order_amount INTEGER,
      client_phone TEXT,
      additional_phone TEXT,
      payment_provider TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_order_logs_created_at ON order_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_order_logs_order_id ON order_logs(order_id);
  `);

  try {
    db.exec('ALTER TABLE order_logs ADD COLUMN additional_phone TEXT');
  } catch {
    // column already exists
  }

  try {
    db.exec('ALTER TABLE order_logs ADD COLUMN payment_provider TEXT');
  } catch {
    // column already exists
  }
}

function formatActorName(user?: any) {
  if (!user) return null;
  const parts = [user.display_name, user.first_name, user.last_name].filter(Boolean);
  const fullName = parts.join(' ').trim();
  if (fullName && user.username) {
    return `${fullName} (@${user.username})`;
  }
  if (fullName) return fullName;
  if (user.username) return `@${user.username}`;
  return user.phone || null;
}

function resolveActor(db: Db, telegramId?: any) {
  if (!telegramId) {
    return { actorTelegramId: null, actorPhone: null, actorName: null };
  }
  const { getBotUserByTelegramId } = (require('./bot-users-db') as typeof import('./bot-users-db'));
  const user = getBotUserByTelegramId(db, telegramId);
  return {
    actorTelegramId: telegramId,
    actorPhone: user?.phone ?? null,
    actorName: formatActorName(user),
  };
}

function logOrderEvent(
  db: Db,
  {
    orderId,
    action,
    actorTelegramId,
    actorPhone,
    actorName,
    orderAmount,
    clientPhone,
    additionalPhone,
    paymentProvider,
  }: Unchecked
) {
  ensureOrderLogsTable(db);
  const actor =
    actorPhone || actorName
      ? { actorTelegramId, actorPhone, actorName }
      : resolveActor(db, actorTelegramId);

  db.prepare(
    `INSERT INTO order_logs (
      order_id, action, actor_telegram_id, actor_phone, actor_name,
      order_amount, client_phone, additional_phone, payment_provider, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    orderId,
    action,
    actor.actorTelegramId ?? actorTelegramId ?? null,
    actor.actorPhone ?? null,
    actor.actorName ?? null,
    orderAmount ?? null,
    clientPhone ?? null,
    additionalPhone ?? null,
    paymentProvider ?? null
  );
}

function orderLogMatchesQuery(row?: any, query?: any) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return true;

  const lower = trimmed.toLowerCase();
  const digits = lower.replace(/\D/g, '');
  const phones = [row.client_phone, row.additional_phone, row.actor_phone].filter(Boolean);

  if (digits && phones.some((phone?: any) => String(phone).replace(/\D/g, '').includes(digits))) {
    return true;
  }

  const searchable = [
    row.order_id,
    row.client_phone,
    row.additional_phone,
    row.actor_phone,
    row.actor_name,
    row.action,
    ACTION_LABELS[row.action as keyof typeof ACTION_LABELS],
    row.payment_provider,
    PAYMENT_PROVIDER_LABELS[row.payment_provider as keyof typeof PAYMENT_PROVIDER_LABELS],
    row.actor_telegram_id != null ? String(row.actor_telegram_id) : '',
    row.order_amount != null ? String(row.order_amount) : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return searchable.includes(lower);
}

function listOrderLogs(db: Db, { query, offset = 0, limit = 25, sort }: Unchecked = {}) {
  ensureOrderLogsTable(db);
  const orderBy =
    resolveListOrderBy(
      sort,
      {
        id: 'id',
        created_at: 'datetime(created_at)',
        action: 'action COLLATE NOCASE',
        order_id: 'order_id COLLATE NOCASE',
        amount: 'order_amount',
        client: 'client_phone COLLATE NOCASE',
        additional: 'additional_phone COLLATE NOCASE',
        payment: 'payment_provider COLLATE NOCASE',
        actor: 'actor_name COLLATE NOCASE',
      },
      'id',
    ) || 'ORDER BY datetime(created_at) DESC';
  let rows = db
    .prepare(
      `SELECT * FROM order_logs
       ${orderBy}`
    )
    .all();

  if (query) {
    rows = rows.filter((row?: any) => orderLogMatchesQuery(row, query));
  }

  const total = rows.length;
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  return {
    logs: rows.slice(safeOffset, safeOffset + safeLimit),
    total,
  };
}

const ACTION_LABELS = {
  created: 'Создан',
  deleted: 'Удалён',
  paid: 'Оплачен',
  paid_cash: 'Оплачен наличными',
  sms_sent: 'SMS отправлено',
  sms_failed: 'SMS ошибка',
};

const PAYMENT_PROVIDER_LABELS = {
  payme: 'Payme',
  click: 'CLICK',
  cash: 'Наличные',
};

function formatPaymentProviderLabel(provider?: any) {
  if (!provider) return null;
  return PAYMENT_PROVIDER_LABELS[provider as keyof typeof PAYMENT_PROVIDER_LABELS] || String(provider);
}

function mapOrderLogRow(row?: any) {
  return {
    id: row.id,
    order_id: row.order_id,
    action: row.action,
    action_label: ACTION_LABELS[row.action as keyof typeof ACTION_LABELS] || row.action,
    actor_telegram_id: row.actor_telegram_id,
    actor_phone: row.actor_phone,
    actor_name: row.actor_name,
    order_amount: row.order_amount,
    client_phone: row.client_phone,
    additional_phone: row.additional_phone ?? null,
    payment_provider: row.payment_provider ?? null,
    payment_provider_label: formatPaymentProviderLabel(row.payment_provider),
    created_at: row.created_at,
  };
}

export {
  ensureOrderLogsTable,
  logOrderEvent,
  listOrderLogs,
  mapOrderLogRow,
  ACTION_LABELS,
  PAYMENT_PROVIDER_LABELS,
  formatPaymentProviderLabel,
};
