function ensureTelegramTicketSessionsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_ticket_sessions (
      telegram_id INTEGER PRIMARY KEY,
      ticket_id INTEGER NOT NULL,
      chat_id TEXT,
      client_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_telegram_ticket_sessions_ticket_id
      ON telegram_ticket_sessions(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_telegram_ticket_sessions_chat_id
      ON telegram_ticket_sessions(chat_id);
  `);
}

function mapSessionRow(row) {
  if (!row) return null;
  return {
    telegramId: Number(row.telegram_id),
    ticketId: Number(row.ticket_id),
    chatId: row.chat_id == null || row.chat_id === '' ? null : String(row.chat_id),
    clientId:
      row.client_id == null || row.client_id === '' ? null : Number(row.client_id),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function getTelegramTicketSession(db, telegramId) {
  ensureTelegramTicketSessionsTable(db);
  const id = Number(telegramId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db
    .prepare(
      `SELECT telegram_id, ticket_id, chat_id, client_id, created_at, updated_at
       FROM telegram_ticket_sessions
       WHERE telegram_id = ?`
    )
    .get(id);
  return mapSessionRow(row);
}

function getTelegramTicketSessionByTicketId(db, ticketId) {
  ensureTelegramTicketSessionsTable(db);
  const id = Number(ticketId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db
    .prepare(
      `SELECT telegram_id, ticket_id, chat_id, client_id, created_at, updated_at
       FROM telegram_ticket_sessions
       WHERE ticket_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`
    )
    .get(id);
  return mapSessionRow(row);
}

function getTelegramTicketSessionByChatId(db, chatId) {
  ensureTelegramTicketSessionsTable(db);
  const id = String(chatId || '').trim();
  if (!id) return null;
  const row = db
    .prepare(
      `SELECT telegram_id, ticket_id, chat_id, client_id, created_at, updated_at
       FROM telegram_ticket_sessions
       WHERE chat_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`
    )
    .get(id);
  return mapSessionRow(row);
}

function upsertTelegramTicketSession(db, input = {}) {
  ensureTelegramTicketSessionsTable(db);
  const telegramId = Number(input.telegramId ?? input.telegram_id);
  const ticketId = Number(input.ticketId ?? input.ticket_id);
  if (!Number.isInteger(telegramId) || telegramId <= 0) {
    throw new Error('INVALID_TELEGRAM_ID');
  }
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    throw new Error('INVALID_TICKET_ID');
  }
  const chatRaw = input.chatId ?? input.chat_id;
  const chatId =
    chatRaw == null ? null : String(chatRaw).trim() || null;
  const clientRaw = input.clientId ?? input.client_id;
  const clientId =
    clientRaw == null || clientRaw === ''
      ? null
      : Number(clientRaw);
  if (clientId != null && (!Number.isInteger(clientId) || clientId <= 0)) {
    throw new Error('INVALID_CLIENT_ID');
  }

  db.prepare(
    `INSERT INTO telegram_ticket_sessions (
       telegram_id, ticket_id, chat_id, client_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(telegram_id) DO UPDATE SET
       ticket_id = excluded.ticket_id,
       chat_id = excluded.chat_id,
       client_id = excluded.client_id,
       updated_at = datetime('now')`
  ).run(telegramId, ticketId, chatId, clientId);

  return getTelegramTicketSession(db, telegramId);
}

function clearTelegramTicketSession(db, telegramId) {
  ensureTelegramTicketSessionsTable(db);
  const id = Number(telegramId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = db.prepare('DELETE FROM telegram_ticket_sessions WHERE telegram_id = ?').run(id);
  return result.changes > 0;
}

module.exports = {
  ensureTelegramTicketSessionsTable,
  getTelegramTicketSession,
  getTelegramTicketSessionByTicketId,
  getTelegramTicketSessionByChatId,
  upsertTelegramTicketSession,
  clearTelegramTicketSession,
};
