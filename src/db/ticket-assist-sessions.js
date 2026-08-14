const { mapSessionMessage, stringifyAttachments } = require('../ai/chat-uploads');

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col) => col.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function ensureTicketAssistTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_ticket_assist_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      ticket_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_ticket_assist_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES ai_ticket_assist_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_ai_ticket_assist_sessions_user_ticket
      ON ai_ticket_assist_sessions (user_id, ticket_id, updated_at);
  `);
  if (tableExists(db, 'ai_ticket_assist_messages')) {
    ensureColumn(db, 'ai_ticket_assist_messages', 'attachments', 'TEXT');
  }
}

function normalizeTicketId(value) {
  const id = Number(value);
  if (!Number.isFinite(id) || id <= 0) {
    const error = new Error('INVALID_TICKET_ID');
    throw error;
  }
  return id;
}

function normalizeOptionalUserId(value) {
  if (value == null || value === '') return null;
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function mapSession(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    user_id: row.user_id != null ? Number(row.user_id) : null,
    ticket_id: Number(row.ticket_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function sessionBelongsTo({ session, userId, ticketId }) {
  if (!session) return false;
  if (Number(session.ticket_id) !== Number(ticketId)) return false;
  const sessionUser = session.user_id != null ? Number(session.user_id) : null;
  const actorUser = userId != null ? Number(userId) : null;
  return sessionUser === actorUser;
}

function getTicketAssistSession(db, sessionId) {
  ensureTicketAssistTables(db);
  const id = Number(sessionId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return mapSession(db.prepare('SELECT * FROM ai_ticket_assist_sessions WHERE id = ?').get(id));
}

function createTicketAssistSession(db, { userId, ticketId } = {}) {
  ensureTicketAssistTables(db);
  const result = db
    .prepare(
      `INSERT INTO ai_ticket_assist_sessions (user_id, ticket_id, created_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))`
    )
    .run(normalizeOptionalUserId(userId), normalizeTicketId(ticketId));
  return getTicketAssistSession(db, Number(result.lastInsertRowid));
}

function findLatestTicketAssistSession(db, { userId, ticketId } = {}) {
  ensureTicketAssistTables(db);
  const id = normalizeTicketId(ticketId);
  const actorUser = normalizeOptionalUserId(userId);
  if (actorUser != null) {
    return mapSession(
      db
        .prepare(
          `SELECT * FROM ai_ticket_assist_sessions
           WHERE user_id = ? AND ticket_id = ?
           ORDER BY datetime(updated_at) DESC, id DESC
           LIMIT 1`
        )
        .get(actorUser, id)
    );
  }
  return mapSession(
    db
      .prepare(
        `SELECT * FROM ai_ticket_assist_sessions
         WHERE user_id IS NULL AND ticket_id = ?
         ORDER BY datetime(updated_at) DESC, id DESC
         LIMIT 1`
      )
      .get(id)
  );
}

function getOrCreateTicketAssistSession(db, { sessionId, userId, ticketId, reset = false } = {}) {
  ensureTicketAssistTables(db);
  const id = normalizeTicketId(ticketId);
  const actorUser = normalizeOptionalUserId(userId);
  if (!reset && sessionId) {
    const existing = getTicketAssistSession(db, sessionId);
    if (existing && sessionBelongsTo({ session: existing, userId: actorUser, ticketId: id })) {
      return existing;
    }
  }
  if (!reset) {
    const latest = findLatestTicketAssistSession(db, { userId: actorUser, ticketId: id });
    if (latest) return latest;
  }
  return createTicketAssistSession(db, { userId: actorUser, ticketId: id });
}

function listTicketAssistMessages(db, sessionId, { limit = 50 } = {}) {
  ensureTicketAssistTables(db);
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  return db
    .prepare(
      `SELECT id, session_id, role, content, attachments, created_at
       FROM ai_ticket_assist_messages
       WHERE session_id = ?
       ORDER BY id ASC
       LIMIT ?`
    )
    .all(Number(sessionId), safeLimit)
    .map(mapSessionMessage);
}

function addTicketAssistMessage(db, sessionId, { role, content, attachments } = {}) {
  ensureTicketAssistTables(db);
  const normalizedRole = role === 'assistant' ? 'assistant' : 'user';
  const text = String(content || '').trim();
  const stored = stringifyAttachments(attachments);
  if (!text && !stored) throw new Error('EMPTY_MESSAGE');
  db.prepare(
    `INSERT INTO ai_ticket_assist_messages (session_id, role, content, attachments, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(Number(sessionId), normalizedRole, text, stored);
  db.prepare(`UPDATE ai_ticket_assist_sessions SET updated_at = datetime('now') WHERE id = ?`).run(
    Number(sessionId)
  );
  return listTicketAssistMessages(db, sessionId);
}

module.exports = {
  ensureTicketAssistTables,
  getTicketAssistSession,
  createTicketAssistSession,
  getOrCreateTicketAssistSession,
  listTicketAssistMessages,
  addTicketAssistMessage,
};
