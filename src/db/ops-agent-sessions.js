const { mapSessionMessage, stringifyAttachments } = require('../ai/chat-uploads');

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

function ensureColumn(db, table, column, ddl) {
  if (!tableExists(db, table)) return;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col) => col.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function ensureOpsAgentSessionTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_ops_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_ops_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES ai_ops_sessions(id) ON DELETE CASCADE
    );
  `);
  ensureColumn(db, 'ai_ops_messages', 'attachments', 'TEXT');
}

function getOrCreateOpsSession(db, { sessionId, userId, reset = false } = {}) {
  ensureOpsAgentSessionTables(db);
  if (!reset && sessionId) {
    const existing = db.prepare('SELECT * FROM ai_ops_sessions WHERE id = ?').get(Number(sessionId));
    if (existing) return existing;
  }
  if (!reset && userId != null) {
    const latest = db
      .prepare(
        `SELECT * FROM ai_ops_sessions
         WHERE user_id = ?
         ORDER BY datetime(updated_at) DESC, id DESC
         LIMIT 1`
      )
      .get(Number(userId));
    if (latest) return latest;
  }
  const result = db
    .prepare(
      `INSERT INTO ai_ops_sessions (user_id, created_at, updated_at)
       VALUES (?, datetime('now'), datetime('now'))`
    )
    .run(userId ?? null);
  return db.prepare('SELECT * FROM ai_ops_sessions WHERE id = ?').get(Number(result.lastInsertRowid));
}

function listOpsSessionMessages(db, sessionId, { limit = 50 } = {}) {
  ensureOpsAgentSessionTables(db);
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  return db
    .prepare(
      `SELECT id, session_id, role, content, attachments, created_at
       FROM ai_ops_messages
       WHERE session_id = ?
       ORDER BY id ASC
       LIMIT ?`
    )
    .all(Number(sessionId), safeLimit)
    .map(mapSessionMessage);
}

function addOpsSessionMessage(db, sessionId, { role, content, attachments } = {}) {
  ensureOpsAgentSessionTables(db);
  const normalizedRole = role === 'assistant' ? 'assistant' : 'user';
  const text = String(content || '').trim();
  const stored = stringifyAttachments(attachments);
  if (!text && !stored) throw new Error('EMPTY_MESSAGE');
  db.prepare(
    `INSERT INTO ai_ops_messages (session_id, role, content, attachments, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(Number(sessionId), normalizedRole, text, stored);
  db.prepare(`UPDATE ai_ops_sessions SET updated_at = datetime('now') WHERE id = ?`).run(Number(sessionId));
  return listOpsSessionMessages(db, sessionId);
}

function sessionBelongsToUser(session, userId) {
  if (userId == null || session?.user_id == null) return true;
  return Number(session.user_id) === Number(userId);
}

function clearOpsSessionHistory(db, { sessionId, userId } = {}) {
  ensureOpsAgentSessionTables(db);
  const session = getOrCreateOpsSession(db, { sessionId, userId });
  if (!sessionBelongsToUser(session, userId)) {
    throw new Error('FORBIDDEN');
  }
  db.prepare('DELETE FROM ai_ops_messages WHERE session_id = ?').run(session.id);
  db.prepare(`UPDATE ai_ops_sessions SET updated_at = datetime('now') WHERE id = ?`).run(session.id);
  return session;
}

module.exports = {
  ensureOpsAgentSessionTables,
  getOrCreateOpsSession,
  listOpsSessionMessages,
  addOpsSessionMessage,
  clearOpsSessionHistory,
};
