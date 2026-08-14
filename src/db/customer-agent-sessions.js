const { mapSessionMessage, stringifyAttachments } = require('../ai/chat-uploads');

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col) => col.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
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
  if (tableExists(db, 'ai_customer_test_messages')) {
    ensureColumn(db, 'ai_customer_test_messages', 'attachments', 'TEXT');
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

function mapSession(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    user_id: row.user_id != null ? Number(row.user_id) : null,
    ticket_id: row.ticket_id != null ? Number(row.ticket_id) : null,
    client_phone: row.client_phone || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getCustomerTestSession(db, sessionId) {
  ensureCustomerTestTables(db);
  const id = Number(sessionId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return mapSession(db.prepare('SELECT * FROM ai_customer_test_sessions WHERE id = ?').get(id));
}

function createCustomerTestSession(db, { userId, ticketId, clientPhone } = {}) {
  ensureCustomerTestTables(db);
  const result = db
    .prepare(
      `INSERT INTO ai_customer_test_sessions (user_id, ticket_id, client_phone, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))`
    )
    .run(userId ?? null, normalizeOptionalTicketId(ticketId), normalizeOptionalPhone(clientPhone));
  return getCustomerTestSession(db, Number(result.lastInsertRowid));
}

function getOrCreateCustomerTestSession(db, { sessionId, userId, ticketId, clientPhone, reset = false } = {}) {
  ensureCustomerTestTables(db);
  if (!reset && sessionId) {
    const existing = getCustomerTestSession(db, sessionId);
    if (existing) return existing;
  }
  if (!reset && userId != null) {
    const latest = mapSession(
      db
        .prepare(
          `SELECT * FROM ai_customer_test_sessions
           WHERE user_id = ?
           ORDER BY datetime(updated_at) DESC, id DESC
           LIMIT 1`
        )
        .get(Number(userId))
    );
    if (latest) return latest;
  }
  return createCustomerTestSession(db, { userId, ticketId, clientPhone });
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
      `SELECT id, session_id, role, content, attachments, created_at
       FROM ai_customer_test_messages
       WHERE session_id = ?
       ORDER BY id ASC
       LIMIT ?`
    )
    .all(Number(sessionId), safeLimit)
    .map(mapSessionMessage);
}

function addCustomerTestMessage(db, sessionId, { role, content, attachments } = {}) {
  ensureCustomerTestTables(db);
  const normalizedRole = role === 'assistant' ? 'assistant' : 'user';
  const text = String(content || '').trim();
  const stored = stringifyAttachments(attachments);
  if (!text && !stored) throw new Error('EMPTY_MESSAGE');
  db.prepare(
    `INSERT INTO ai_customer_test_messages (session_id, role, content, attachments, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(Number(sessionId), normalizedRole, text, stored);
  db.prepare(`UPDATE ai_customer_test_sessions SET updated_at = datetime('now') WHERE id = ?`).run(Number(sessionId));
  return listCustomerTestMessages(db, sessionId);
}

module.exports = {
  ensureCustomerTestTables,
  getCustomerTestSession,
  createCustomerTestSession,
  getOrCreateCustomerTestSession,
  updateCustomerTestSession,
  listCustomerTestMessages,
  addCustomerTestMessage,
};
