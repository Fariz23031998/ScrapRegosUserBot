import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { resolveListOrderBy } from './list-sort';

function ensureAdminAuditLogsTable(db: Db) {
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

function formatActorName(user?: any) {
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

function resolveActorFromSession(db: Db, actor?: any) {
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

  if (actor.type === 'mcp') {
    return {
      actorType: 'mcp',
      actorUserId: null,
      actorTelegramId: null,
      actorPhone: null,
      actorName: 'MCP',
    };
  }

  const { getBotUserByTelegramId, getBotUserById } = (require('./bot-users-db') as typeof import('./bot-users-db'));
  let user: any = null;
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

function serializeDetails(details?: any) {
  if (details == null) return null;
  try {
    return JSON.stringify(details);
  } catch {
    return null;
  }
}

const SECRET_KEYS: Set<any> = new Set([
  'password',
  'password_hash',
  'new_password',
  'current_password',
  'admin_password',
]);

function sanitizeAuditValue(value: any, depth: any = 0): any {
  if (value == null) return value;
  if (depth > 6) return '[…]';
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item?: any): any => sanitizeAuditValue(item, depth + 1));
  }
  if (typeof value !== 'object') return value;

  const out: Unchecked = {};
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

function valuesEqual(a?: any, b?: any) {
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

function buildFieldChanges(before?: any, after?: any, keys?: any) {
  const changes: Unchecked = {};
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

function buildAuditDetails({ before = null, after = null, changes, ...rest }: Unchecked = {}) {
  const sanitizedBefore = before == null ? null : sanitizeAuditValue(before);
  const sanitizedAfter = after == null ? null : sanitizeAuditValue(after);
  let fieldChanges: any;
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
  db: Db,
  {
    entityType,
    entityId,
    action,
    summary,
    details,
    actor,
  }: Unchecked
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
  ai_prompt: 'Промпт AI',
  knowledge_article: 'Статья базы знаний',
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
  lock: 'Блокировка',
  unlock: 'Разблокировка',
};

function auditLogMatchesQuery(row?: any, query?: any) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return true;

  const lower = trimmed.toLowerCase();
  const digits = lower.replace(/\D/g, '');

  if (digits && row.actor_phone && String(row.actor_phone).replace(/\D/g, '').includes(digits)) {
    return true;
  }

  const searchable = [
    row.entity_type,
    ENTITY_LABELS[row.entity_type as keyof typeof ENTITY_LABELS],
    row.entity_id,
    row.action,
    ACTION_LABELS[row.action as keyof typeof ACTION_LABELS],
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

function listAdminAuditLogs(db: Db, { query, offset = 0, limit = 25, sort }: Unchecked = {}) {
  ensureAdminAuditLogsTable(db);
  const orderBy =
    resolveListOrderBy(
      sort,
      {
        id: 'id',
        created_at: 'datetime(created_at)',
        action: 'action COLLATE NOCASE',
        entity: 'entity_type COLLATE NOCASE',
        description: 'summary COLLATE NOCASE',
        actor: 'actor_name COLLATE NOCASE',
      },
      'id',
    ) || 'ORDER BY datetime(created_at) DESC';
  let rows = db
    .prepare(
      `SELECT * FROM admin_audit_logs
       ${orderBy}`
    )
    .all();

  if (query) {
    rows = rows.filter((row?: any) => auditLogMatchesQuery(row, query));
  }

  const total = rows.length;
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  return {
    logs: rows.slice(safeOffset, safeOffset + safeLimit),
    total,
  };
}

function mapAdminAuditLogRow(row?: any) {
  let details: any = null;
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
    entity_type_label: ENTITY_LABELS[row.entity_type as keyof typeof ENTITY_LABELS] || row.entity_type,
    entity_id: row.entity_id,
    action: row.action,
    action_label: ACTION_LABELS[row.action as keyof typeof ACTION_LABELS] || row.action,
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

export {
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
