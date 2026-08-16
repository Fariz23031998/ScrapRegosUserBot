const USAGE_WINDOW_MINUTES = 60;

function ensureAiCustomerUsageTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_customer_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER,
      client_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ai_customer_usage_client_created
      ON ai_customer_usage (client_key, created_at);
  `);
}

function resolveCustomerUsageKey(ticket, chatId) {
  const { resolveTicketClientId } = require('../ai/ticket-period');
  const clientId = resolveTicketClientId(ticket);
  if (clientId) return `client:${clientId}`;
  const phone = String(ticket?.client?.phone || '').replace(/\D/g, '');
  if (phone) return `phone:${phone}`;
  const chat = String(chatId || ticket?.chat_id || '').trim();
  return chat ? `chat:${chat}` : 'chat:unknown';
}

function countCustomerUsageSince(db, clientKey, minutes = USAGE_WINDOW_MINUTES) {
  ensureAiCustomerUsageTable(db);
  const key = String(clientKey || '').trim();
  if (!key) return 0;
  const window = Math.max(1, Number(minutes) || USAGE_WINDOW_MINUTES);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM ai_customer_usage
       WHERE client_key = ? AND created_at >= datetime('now', ?)`
    )
    .get(key, `-${window} minutes`);
  return Number(row?.n) || 0;
}

function recordCustomerUsage(db, { ticketId, clientKey } = {}) {
  ensureAiCustomerUsageTable(db);
  const key = String(clientKey || '').trim();
  if (!key) return null;
  db.prepare(
    `DELETE FROM ai_customer_usage WHERE created_at < datetime('now', '-2 hours')`
  ).run();
  const id = Number(ticketId);
  const result = db
    .prepare(`INSERT INTO ai_customer_usage (ticket_id, client_key) VALUES (?, ?)`)
    .run(Number.isInteger(id) && id > 0 ? id : null, key);
  return Number(result.lastInsertRowid) || null;
}

module.exports = {
  USAGE_WINDOW_MINUTES,
  ensureAiCustomerUsageTable,
  resolveCustomerUsageKey,
  countCustomerUsageSince,
  recordCustomerUsage,
};
