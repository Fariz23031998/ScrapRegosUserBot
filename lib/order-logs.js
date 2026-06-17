function ensureOrderLogsTable(db) {
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_order_logs_created_at ON order_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_order_logs_order_id ON order_logs(order_id);
  `);
}

function formatActorName(user) {
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

function resolveActor(db, telegramId) {
  if (!telegramId) {
    return { actorTelegramId: null, actorPhone: null, actorName: null };
  }
  const { getBotUserByTelegramId } = require('./bot-users-db');
  const user = getBotUserByTelegramId(db, telegramId);
  return {
    actorTelegramId: telegramId,
    actorPhone: user?.phone ?? null,
    actorName: formatActorName(user),
  };
}

function logOrderEvent(
  db,
  { orderId, action, actorTelegramId, actorPhone, actorName, orderAmount, clientPhone }
) {
  ensureOrderLogsTable(db);
  const actor =
    actorPhone || actorName
      ? { actorTelegramId, actorPhone, actorName }
      : resolveActor(db, actorTelegramId);

  db.prepare(
    `INSERT INTO order_logs (
      order_id, action, actor_telegram_id, actor_phone, actor_name,
      order_amount, client_phone, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    orderId,
    action,
    actor.actorTelegramId ?? actorTelegramId ?? null,
    actor.actorPhone ?? null,
    actor.actorName ?? null,
    orderAmount ?? null,
    clientPhone ?? null
  );
}

function orderLogMatchesQuery(row, query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return true;

  const lower = trimmed.toLowerCase();
  const digits = lower.replace(/\D/g, '');
  const phones = [row.client_phone, row.actor_phone].filter(Boolean);

  if (digits && phones.some((phone) => String(phone).replace(/\D/g, '').includes(digits))) {
    return true;
  }

  const searchable = [
    row.order_id,
    row.client_phone,
    row.actor_phone,
    row.actor_name,
    row.action,
    ACTION_LABELS[row.action],
    row.actor_telegram_id != null ? String(row.actor_telegram_id) : '',
    row.order_amount != null ? String(row.order_amount) : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return searchable.includes(lower);
}

function listOrderLogs(db, { query, offset = 0, limit = 25 } = {}) {
  ensureOrderLogsTable(db);
  let rows = db
    .prepare(
      `SELECT * FROM order_logs
       ORDER BY datetime(created_at) DESC`
    )
    .all();

  if (query) {
    rows = rows.filter((row) => orderLogMatchesQuery(row, query));
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
};

function mapOrderLogRow(row) {
  return {
    id: row.id,
    order_id: row.order_id,
    action: row.action,
    action_label: ACTION_LABELS[row.action] || row.action,
    actor_telegram_id: row.actor_telegram_id,
    actor_phone: row.actor_phone,
    actor_name: row.actor_name,
    order_amount: row.order_amount,
    client_phone: row.client_phone,
    created_at: row.created_at,
  };
}

module.exports = {
  ensureOrderLogsTable,
  logOrderEvent,
  listOrderLogs,
  mapOrderLogRow,
  ACTION_LABELS,
};
