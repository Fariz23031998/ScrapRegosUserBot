const { mapSessionMessage, stringifyAttachments } = require('../ai/chat-uploads');

const AGENT_KINDS = new Set(['customer', 'employee']);
const TITLE_MAX = 80;

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col) => col.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function normalizeAgentKind(value) {
  const kind = String(value || 'customer').trim();
  return AGENT_KINDS.has(kind) ? kind : 'customer';
}

function ensureCustomerTestTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_customer_test_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      ticket_id INTEGER,
      client_phone TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_customer_test_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES ai_customer_test_sessions(id) ON DELETE CASCADE
    );
  `);
  if (tableExists(db, 'ai_customer_test_sessions')) {
    ensureColumn(db, 'ai_customer_test_sessions', 'agent_kind', "TEXT NOT NULL DEFAULT 'customer'");
  }
  if (tableExists(db, 'ai_customer_test_messages')) {
    ensureColumn(db, 'ai_customer_test_messages', 'attachments', 'TEXT');
    ensureColumn(db, 'ai_customer_test_messages', 'run_json', 'TEXT');
  }
}

function normalizeOptionalTicketId(value) {
  if (value == null || value === '') return null;
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function normalizeOptionalPhone(value) {
  const phone = String(value || '').trim();
  return phone || null;
}

function parseRunJson(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function stringifyRun(run) {
  if (!run || typeof run !== 'object') return null;
  try {
    return JSON.stringify(run);
  } catch {
    return null;
  }
}

function mapTestMessage(row) {
  const mapped = mapSessionMessage(row);
  if (!mapped) return null;
  mapped.run = parseRunJson(row.run_json);
  return mapped;
}

function mapSession(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    user_id: row.user_id != null ? Number(row.user_id) : null,
    ticket_id: row.ticket_id != null ? Number(row.ticket_id) : null,
    client_phone: row.client_phone || null,
    agent_kind: normalizeAgentKind(row.agent_kind),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function sessionUserLabel(row) {
  const parts = [
    row.display_name,
    row.regos_full_name,
    [row.first_name, row.last_name].filter(Boolean).join(' '),
    row.admin_login,
    row.phone,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (parts.length) return parts[0];
  if (row.user_id != null) return `Пользователь #${row.user_id}`;
  return 'Администратор';
}

function snippetTitle(value) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 'Пустой чат';
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
}

function canAccessCustomerTestSession(session, { userId, allowAnyUser } = {}) {
  if (!session) return false;
  if (allowAnyUser) return true;
  if (userId == null) return session.user_id == null;
  return Number(session.user_id) === Number(userId);
}

function requireCustomerTestSessionAccess(session, opts) {
  if (!session) {
    throw new Error('SESSION_NOT_FOUND');
  }
  if (!canAccessCustomerTestSession(session, opts)) {
    throw new Error('SESSION_FORBIDDEN');
  }
  return session;
}

function getCustomerTestSession(db, sessionId) {
  ensureCustomerTestTables(db);
  const id = Number(sessionId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return mapSession(db.prepare('SELECT * FROM ai_customer_test_sessions WHERE id = ?').get(id));
}

function createCustomerTestSession(db, { userId, ticketId, clientPhone, agentKind } = {}) {
  ensureCustomerTestTables(db);
  const kind = normalizeAgentKind(agentKind);
  const result = db
    .prepare(
      `INSERT INTO ai_customer_test_sessions (user_id, ticket_id, client_phone, agent_kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .run(userId ?? null, normalizeOptionalTicketId(ticketId), normalizeOptionalPhone(clientPhone), kind);
  return getCustomerTestSession(db, Number(result.lastInsertRowid));
}

function getOrCreateCustomerTestSession(
  db,
  { sessionId, userId, ticketId, clientPhone, agentKind, reset = false, allowAnyUser = false } = {}
) {
  ensureCustomerTestTables(db);
  const kind = normalizeAgentKind(agentKind);
  if (!reset && sessionId) {
    const existing = getCustomerTestSession(db, sessionId);
    if (existing && existing.agent_kind === kind) {
      return requireCustomerTestSessionAccess(existing, { userId, allowAnyUser });
    }
  }
  if (!reset && userId != null) {
    const latest = mapSession(
      db
        .prepare(
          `SELECT * FROM ai_customer_test_sessions
           WHERE user_id = ? AND COALESCE(agent_kind, 'customer') = ?
           ORDER BY datetime(updated_at) DESC, id DESC
           LIMIT 1`
        )
        .get(Number(userId), kind)
    );
    if (latest) return latest;
  } else if (!reset && userId == null && !sessionId) {
    const latest = mapSession(
      db
        .prepare(
          `SELECT * FROM ai_customer_test_sessions
           WHERE user_id IS NULL AND COALESCE(agent_kind, 'customer') = ?
           ORDER BY datetime(updated_at) DESC, id DESC
           LIMIT 1`
        )
        .get(kind)
    );
    if (latest) return latest;
  }
  return createCustomerTestSession(db, { userId, ticketId, clientPhone, agentKind: kind });
}

function updateCustomerTestSession(db, sessionId, { ticketId, clientPhone } = {}) {
  const current = getCustomerTestSession(db, sessionId);
  if (!current) return null;
  const nextTicketId = ticketId === undefined ? current.ticket_id : normalizeOptionalTicketId(ticketId);
  const nextPhone = clientPhone === undefined ? current.client_phone : normalizeOptionalPhone(clientPhone);
  db.prepare(
    `UPDATE ai_customer_test_sessions
     SET ticket_id = ?, client_phone = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(nextTicketId, nextPhone, current.id);
  return getCustomerTestSession(db, current.id);
}

function listCustomerTestMessages(db, sessionId, { limit = 50 } = {}) {
  ensureCustomerTestTables(db);
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  return db
    .prepare(
      `SELECT id, session_id, role, content, attachments, run_json, created_at
       FROM ai_customer_test_messages
       WHERE session_id = ?
       ORDER BY id ASC
       LIMIT ?`
    )
    .all(Number(sessionId), safeLimit)
    .map(mapTestMessage);
}

function addCustomerTestMessage(db, sessionId, { role, content, attachments, run } = {}) {
  ensureCustomerTestTables(db);
  const normalizedRole = role === 'assistant' ? 'assistant' : 'user';
  const text = String(content || '').trim();
  const stored = stringifyAttachments(attachments);
  const storedRun = normalizedRole === 'assistant' ? stringifyRun(run) : null;
  if (!text && !stored) throw new Error('EMPTY_MESSAGE');
  db.prepare(
    `INSERT INTO ai_customer_test_messages (session_id, role, content, attachments, run_json, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(Number(sessionId), normalizedRole, text, stored, storedRun);
  db.prepare(`UPDATE ai_customer_test_sessions SET updated_at = datetime('now') WHERE id = ?`).run(Number(sessionId));
  return listCustomerTestMessages(db, sessionId);
}

function mapListedSession(row) {
  const session = mapSession(row);
  if (!session) return null;
  return {
    ...session,
    title: snippetTitle(row.title),
    user_name: sessionUserLabel(row),
  };
}

function listCustomerTestSessions(db, { userId, agentKind, allUsers = false, allowAnyUser = false } = {}) {
  ensureCustomerTestTables(db);
  const kind = normalizeAgentKind(agentKind);
  if (allUsers && !allowAnyUser) {
    throw new Error('SESSION_FORBIDDEN');
  }
  const sql = `
    SELECT s.*,
      (
        SELECT m.content
        FROM ai_customer_test_messages m
        WHERE m.session_id = s.id AND m.role = 'user'
        ORDER BY m.id ASC
        LIMIT 1
      ) AS title,
      bu.display_name,
      bu.regos_full_name,
      bu.first_name,
      bu.last_name,
      bu.admin_login,
      bu.phone
    FROM ai_customer_test_sessions s
    LEFT JOIN bot_users bu ON bu.id = s.user_id
    WHERE COALESCE(s.agent_kind, 'customer') = ?
      ${allUsers ? '' : userId == null ? 'AND s.user_id IS NULL' : 'AND s.user_id = ?'}
    ORDER BY datetime(s.updated_at) DESC, s.id DESC
    LIMIT 100
  `;
  const rows = allUsers
    ? db.prepare(sql).all(kind)
    : userId == null
      ? db.prepare(sql).all(kind)
      : db.prepare(sql).all(kind, Number(userId));
  return rows.map(mapListedSession).filter(Boolean);
}

function deleteCustomerTestSession(db, sessionId, { userId, allowAnyUser } = {}) {
  const session = getCustomerTestSession(db, sessionId);
  if (!session) return false;
  requireCustomerTestSessionAccess(session, { userId, allowAnyUser });
  db.prepare('DELETE FROM ai_customer_test_messages WHERE session_id = ?').run(session.id);
  db.prepare('DELETE FROM ai_customer_test_sessions WHERE id = ?').run(session.id);
  return true;
}

function clearCustomerTestSessions(
  db,
  { userId, agentKind, allUsers = false, allowAnyUser = false } = {}
) {
  ensureCustomerTestTables(db);
  const kind = normalizeAgentKind(agentKind);
  if (allUsers && !allowAnyUser) {
    throw new Error('SESSION_FORBIDDEN');
  }
  const ids = allUsers
    ? db
        .prepare(
          `SELECT id FROM ai_customer_test_sessions WHERE COALESCE(agent_kind, 'customer') = ?`
        )
        .all(kind)
    : userId == null
      ? db
          .prepare(
            `SELECT id FROM ai_customer_test_sessions
             WHERE user_id IS NULL AND COALESCE(agent_kind, 'customer') = ?`
          )
          .all(kind)
      : db
          .prepare(
            `SELECT id FROM ai_customer_test_sessions
             WHERE user_id = ? AND COALESCE(agent_kind, 'customer') = ?`
          )
          .all(Number(userId), kind);
  const deleteMessages = db.prepare('DELETE FROM ai_customer_test_messages WHERE session_id = ?');
  const deleteSession = db.prepare('DELETE FROM ai_customer_test_sessions WHERE id = ?');
  for (const row of ids) {
    deleteMessages.run(row.id);
    deleteSession.run(row.id);
  }
  return { deleted: ids.length };
}

module.exports = {
  ensureCustomerTestTables,
  normalizeAgentKind,
  canAccessCustomerTestSession,
  requireCustomerTestSessionAccess,
  getCustomerTestSession,
  createCustomerTestSession,
  getOrCreateCustomerTestSession,
  updateCustomerTestSession,
  listCustomerTestMessages,
  addCustomerTestMessage,
  listCustomerTestSessions,
  deleteCustomerTestSession,
  clearCustomerTestSessions,
};
