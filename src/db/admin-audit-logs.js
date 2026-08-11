function ensureAdminAuditLogsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      action TEXT NOT NULL,
      summary TEXT,
      details_json TEXT,
      actor_type TEXT,
      actor_user_id INTEGER,
      actor_telegram_id INTEGER,
      actor_phone TEXT,
      actor_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at ON admin_audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_entity_type ON admin_audit_logs(entity_type);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_action ON admin_audit_logs(action);
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
  if (user.admin_login) return user.admin_login;
  return user.phone || null;
}

function resolveActorFromSession(db, actor) {
  if (!actor) {
    return {
      actorType: null,
      actorUserId: null,
      actorTelegramId: null,
      actorPhone: null,
      actorName: null,
    };
  }

  if (actor.type === 'password') {
    const login = process.env.BOT_ADMIN_LOGIN?.trim() || 'admin';
    return {
      actorType: 'password',
      actorUserId: null,
      actorTelegramId: null,
      actorPhone: null,
      actorName: `${login} (пароль)`,
    };
  }

  const { getBotUserByTelegramId, getBotUserById } = require('./bot-users-db');
  let user = null;
  if (actor.type === 'telegram') {
    user = getBotUserByTelegramId(db, actor.telegramId);
  } else if (actor.type === 'user') {
    user = getBotUserById(db, actor.userId);
  }

  return {
    actorType: actor.type,
    actorUserId: user?.id ?? (actor.type === 'user' ? actor.userId : null),
    actorTelegramId: user?.telegram_id ?? (actor.type === 'telegram' ? actor.telegramId : null),
    actorPhone: user?.phone ?? null,
    actorName: formatActorName(user),
  };
}

function serializeDetails(details) {
  if (details == null) return null;
  try {
    return JSON.stringify(details);
  } catch {
    return null;
  }
}

const SECRET_KEYS = new Set([
  'password',
  'password_hash',
  'new_password',
  'current_password',
  'admin_password',
]);

function sanitizeAuditValue(value, depth = 0) {
  if (value == null) return value;
  if (depth > 6) return '[…]';
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeAuditValue(item, depth + 1));
  }
  if (typeof value !== 'object') return value;

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) {
      if (item == null || item === '') {
        out[key] = item;
      } else {
        out[key] = '[изменено]';
      }
      continue;
    }
    out[key] = sanitizeAuditValue(item, depth + 1);
  }
  return out;
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (typeof a === 'object' || typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return String(a) === String(b);
}

function buildFieldChanges(before, after, keys) {
  const changes = {};
  const fieldKeys =
    keys ||
    Array.from(
      new Set([
        ...Object.keys(before && typeof before === 'object' ? before : {}),
        ...Object.keys(after && typeof after === 'object' ? after : {}),
      ])
    );
  for (const key of fieldKeys) {
    if (SECRET_KEYS.has(key)) {
      const fromSet = before != null && before[key] != null && before[key] !== '';
      const toSet = after != null && after[key] != null && after[key] !== '';
      if (fromSet || toSet) {
        changes[key] = {
          from: fromSet ? '[скрыто]' : null,
          to: toSet ? '[изменено]' : null,
        };
      }
      continue;
    }
    const from = before ? before[key] : undefined;
    const to = after ? after[key] : undefined;
    if (!valuesEqual(from, to)) {
      changes[key] = {
        from: from === undefined ? null : from,
        to: to === undefined ? null : to,
      };
    }
  }
  return changes;
}

function buildAuditDetails({ before = null, after = null, changes, ...rest } = {}) {
  const sanitizedBefore = before == null ? null : sanitizeAuditValue(before);
  const sanitizedAfter = after == null ? null : sanitizeAuditValue(after);
  let fieldChanges;
  if (changes !== undefined) {
    fieldChanges = changes;
  } else if (sanitizedBefore || sanitizedAfter) {
    fieldChanges = buildFieldChanges(sanitizedBefore || {}, sanitizedAfter || {});
  } else {
    fieldChanges = null;
  }
  return sanitizeAuditValue({
    ...rest,
    before: sanitizedBefore,
    after: sanitizedAfter,
    changes:
      fieldChanges && Object.keys(fieldChanges).length > 0 ? fieldChanges : null,
  });
}

function logAdminAudit(
  db,
  {
    entityType,
    entityId,
    action,
    summary,
    details,
    actor,
  }
) {
  ensureAdminAuditLogsTable(db);
  const resolved = resolveActorFromSession(db, actor);

  db.prepare(
    `INSERT INTO admin_audit_logs (
      entity_type, entity_id, action, summary, details_json,
      actor_type, actor_user_id, actor_telegram_id, actor_phone, actor_name, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    entityType,
    entityId != null ? String(entityId) : null,
    action,
    summary ?? null,
    serializeDetails(details),
    resolved.actorType,
    resolved.actorUserId,
    resolved.actorTelegramId,
    resolved.actorPhone,
    resolved.actorName
  );
}

const ENTITY_LABELS = {
  user: 'Пользователь',
  ticket: 'Тикет',
  order: 'Заказ',
  client: 'Клиент',
  firm_link: 'Связь с фирмой',
  technical_support_price: 'Цены техподдержки',
  technical_support_subscription: 'Подписка техподдержки',
  service_price: 'Прайс',
  channel_settings: 'Настройки каналов',
  account: 'Аккаунт',
  rights: 'Права',
};

const ACTION_LABELS = {
  create: 'Создание',
  update: 'Изменение',
  delete: 'Удаление',
  promote: 'Повышение',
  link_regos: 'Привязка REGOS',
  unlink_regos: 'Отвязка REGOS',
  auto_link_regos: 'Автопривязка REGOS',
  deactivate: 'Деактивация',
  renotify: 'Повторное уведомление',
  paid_cash: 'Оплата наличными',
  delete_unpaid: 'Удаление неоплаченного',
  delete_cash: 'Удаление наличных',
  send_message: 'Сообщение',
};

function auditLogMatchesQuery(row, query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return true;

  const lower = trimmed.toLowerCase();
  const digits = lower.replace(/\D/g, '');

  if (digits && row.actor_phone && String(row.actor_phone).replace(/\D/g, '').includes(digits)) {
    return true;
  }

  const searchable = [
    row.entity_type,
    ENTITY_LABELS[row.entity_type],
    row.entity_id,
    row.action,
    ACTION_LABELS[row.action],
    row.summary,
    row.actor_type,
    row.actor_phone,
    row.actor_name,
    row.actor_telegram_id != null ? String(row.actor_telegram_id) : '',
    row.actor_user_id != null ? String(row.actor_user_id) : '',
    row.details_json,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return searchable.includes(lower);
}

function listAdminAuditLogs(db, { query, offset = 0, limit = 25 } = {}) {
  ensureAdminAuditLogsTable(db);
  let rows = db
    .prepare(
      `SELECT * FROM admin_audit_logs
       ORDER BY datetime(created_at) DESC`
    )
    .all();

  if (query) {
    rows = rows.filter((row) => auditLogMatchesQuery(row, query));
  }

  const total = rows.length;
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  return {
    logs: rows.slice(safeOffset, safeOffset + safeLimit),
    total,
  };
}

function mapAdminAuditLogRow(row) {
  let details = null;
  if (row.details_json) {
    try {
      details = JSON.parse(row.details_json);
    } catch {
      details = null;
    }
  }

  return {
    id: row.id,
    entity_type: row.entity_type,
    entity_type_label: ENTITY_LABELS[row.entity_type] || row.entity_type,
    entity_id: row.entity_id,
    action: row.action,
    action_label: ACTION_LABELS[row.action] || row.action,
    summary: row.summary,
    details,
    actor_type: row.actor_type,
    actor_user_id: row.actor_user_id,
    actor_telegram_id: row.actor_telegram_id,
    actor_phone: row.actor_phone,
    actor_name: row.actor_name,
    created_at: row.created_at,
  };
}

module.exports = {
  ensureAdminAuditLogsTable,
  logAdminAudit,
  listAdminAuditLogs,
  mapAdminAuditLogRow,
  buildAuditDetails,
  buildFieldChanges,
  sanitizeAuditValue,
  ENTITY_LABELS,
  ACTION_LABELS,
};
