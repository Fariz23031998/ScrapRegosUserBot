/**
 * Per-ticket mute for the **customer** auto-reply agent only.
 * Does not affect ticket AI assist (employee) or test sandboxes.
 */
function ensureTicketAiStateTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_ai_state (
      ticket_id INTEGER PRIMARY KEY,
      ai_stopped INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
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
    updated_at: row.updated_at || null,
  };
}

function getTicketAiState(db, ticketId) {
  ensureTicketAiStateTable(db);
  const id = Number(ticketId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db
    .prepare(
      `SELECT ticket_id, ai_stopped, updated_at
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
      `SELECT ticket_id, ai_stopped, updated_at
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
  db.prepare(
    `INSERT INTO ticket_ai_state (ticket_id, ai_stopped, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(ticket_id) DO UPDATE SET
       ai_stopped = excluded.ai_stopped,
       updated_at = datetime('now')`
  ).run(id, value);
  return getTicketAiState(db, id);
}

module.exports = {
  ensureTicketAiStateTable,
  getTicketAiState,
  isTicketAiStopped,
  getTicketAiStoppedByIds,
  setTicketAiStopped,
};
