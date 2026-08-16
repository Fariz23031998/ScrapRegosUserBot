/**
 * Per-ticket mute for the **customer** auto-reply agent only.
 * Does not affect ticket AI assist (employee) or test sandboxes.
 */
function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col) => col.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function ensureTicketAiStateTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_ai_state (
      ticket_id INTEGER PRIMARY KEY,
      ai_stopped INTEGER NOT NULL DEFAULT 0,
      customer_reply_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  ensureColumn(db, 'ticket_ai_state', 'customer_reply_count', 'INTEGER NOT NULL DEFAULT 0');
}

function requirePositiveTicketId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error('INVALID_TICKET_ID');
    error.code = 'INVALID_TICKET_ID';
    throw error;
  }
  return id;
}

function mapAiStateRow(row) {
  if (!row) return null;
  return {
    ticket_id: Number(row.ticket_id),
    ai_stopped: Boolean(Number(row.ai_stopped)),
    customer_reply_count: Number(row.customer_reply_count) || 0,
    updated_at: row.updated_at || null,
  };
}

function getTicketAiState(db, ticketId) {
  ensureTicketAiStateTable(db);
  const id = Number(ticketId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db
    .prepare(
      `SELECT ticket_id, ai_stopped, customer_reply_count, updated_at
       FROM ticket_ai_state
       WHERE ticket_id = ?`
    )
    .get(id);
  return mapAiStateRow(row);
}

function isTicketAiStopped(db, ticketId) {
  const state = getTicketAiState(db, ticketId);
  return Boolean(state?.ai_stopped);
}

function getCustomerReplyCount(db, ticketId) {
  const state = getTicketAiState(db, ticketId);
  return Number(state?.customer_reply_count) || 0;
}

function getTicketAiStoppedByIds(db, ticketIds) {
  ensureTicketAiStateTable(db);
  const ids = [...new Set((ticketIds || []).map(Number))].filter(
    (id) => Number.isInteger(id) && id > 0
  );
  const stopped = new Map();
  if (!ids.length) return stopped;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT ticket_id, ai_stopped, customer_reply_count, updated_at
       FROM ticket_ai_state
       WHERE ticket_id IN (${placeholders}) AND ai_stopped = 1`
    )
    .all(...ids);
  for (const row of rows) {
    const mapped = mapAiStateRow(row);
    if (mapped) stopped.set(mapped.ticket_id, mapped);
  }
  return stopped;
}

function setTicketAiStopped(db, ticketId, stopped) {
  ensureTicketAiStateTable(db);
  const id = requirePositiveTicketId(ticketId);
  const value = stopped ? 1 : 0;
  if (value) {
    db.prepare(
      `INSERT INTO ticket_ai_state (ticket_id, ai_stopped, customer_reply_count, updated_at)
       VALUES (?, 1, 0, datetime('now'))
       ON CONFLICT(ticket_id) DO UPDATE SET
         ai_stopped = 1,
         updated_at = datetime('now')`
    ).run(id);
  } else {
    db.prepare(
      `INSERT INTO ticket_ai_state (ticket_id, ai_stopped, customer_reply_count, updated_at)
       VALUES (?, 0, 0, datetime('now'))
       ON CONFLICT(ticket_id) DO UPDATE SET
         ai_stopped = 0,
         customer_reply_count = 0,
         updated_at = datetime('now')`
    ).run(id);
  }
  return getTicketAiState(db, id);
}

function incrementCustomerReplyCount(db, ticketId) {
  ensureTicketAiStateTable(db);
  const id = requirePositiveTicketId(ticketId);
  db.prepare(
    `INSERT INTO ticket_ai_state (ticket_id, ai_stopped, customer_reply_count, updated_at)
     VALUES (?, 0, 1, datetime('now'))
     ON CONFLICT(ticket_id) DO UPDATE SET
       customer_reply_count = COALESCE(ticket_ai_state.customer_reply_count, 0) + 1,
       updated_at = datetime('now')`
  ).run(id);
  return getCustomerReplyCount(db, id);
}

module.exports = {
  ensureTicketAiStateTable,
  getTicketAiState,
  isTicketAiStopped,
  getCustomerReplyCount,
  getTicketAiStoppedByIds,
  setTicketAiStopped,
  incrementCustomerReplyCount,
};
