function ensureTicketSummariesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_summaries (
      ticket_id INTEGER PRIMARY KEY,
      client_id INTEGER,
      chat_id TEXT,
      summary TEXT NOT NULL DEFAULT '',
      model TEXT,
      provider TEXT,
      message_count INTEGER,
      period_start INTEGER,
      period_end INTEGER,
      status TEXT NOT NULL DEFAULT 'done',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_summaries_client_id
      ON ticket_summaries(client_id, period_end DESC);
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

function optionalPositiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function optionalUnix(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : null;
}

function requireSummaryText(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    const error = new Error('INVALID_SUMMARY');
    error.code = 'INVALID_SUMMARY';
    throw error;
  }
  return text;
}

function mapSummaryRow(row) {
  if (!row) return null;
  return {
    ticket_id: Number(row.ticket_id),
    client_id: optionalPositiveId(row.client_id),
    chat_id: row.chat_id ? String(row.chat_id) : null,
    summary: String(row.summary || ''),
    model: row.model || null,
    provider: row.provider || null,
    message_count: Number.isInteger(Number(row.message_count)) ? Number(row.message_count) : 0,
    period_start: optionalUnix(row.period_start),
    period_end: optionalUnix(row.period_end),
    status: String(row.status || 'done'),
    error: row.error || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function getTicketSummary(db, ticketId) {
  ensureTicketSummariesTable(db);
  const id = Number(ticketId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db
    .prepare(
      `SELECT ticket_id, client_id, chat_id, summary, model, provider, message_count,
              period_start, period_end, status, error, created_at, updated_at
       FROM ticket_summaries
       WHERE ticket_id = ?`
    )
    .get(id);
  return mapSummaryRow(row);
}

function hasSuccessfulTicketSummary(db, ticketId) {
  const row = getTicketSummary(db, ticketId);
  return Boolean(row && row.status === 'done' && String(row.summary || '').trim());
}

function upsertTicketSummary(db, input = {}) {
  ensureTicketSummariesTable(db);
  const ticketId = requirePositiveTicketId(input.ticketId ?? input.ticket_id);
  const existing = getTicketSummary(db, ticketId);
  const status = String(input.status || 'done').trim() || 'done';
  db.prepare(
    `INSERT INTO ticket_summaries (
       ticket_id, client_id, chat_id, summary, model, provider, message_count,
       period_start, period_end, status, error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(ticket_id) DO UPDATE SET
       client_id = excluded.client_id,
       chat_id = excluded.chat_id,
       summary = excluded.summary,
       model = excluded.model,
       provider = excluded.provider,
       message_count = excluded.message_count,
       period_start = excluded.period_start,
       period_end = excluded.period_end,
       status = excluded.status,
       error = excluded.error,
       updated_at = datetime('now')`
  ).run(
    ticketId,
    optionalPositiveId(input.clientId ?? input.client_id) ?? existing?.client_id ?? null,
    input.chatId != null || input.chat_id != null
      ? String(input.chatId ?? input.chat_id ?? '').trim() || null
      : existing?.chat_id ?? null,
    String(input.summary ?? existing?.summary ?? ''),
    input.model != null ? String(input.model) : existing?.model ?? null,
    input.provider != null ? String(input.provider) : existing?.provider ?? null,
    Number.isInteger(Number(input.messageCount ?? input.message_count))
      ? Number(input.messageCount ?? input.message_count)
      : existing?.message_count ?? 0,
    optionalUnix(input.periodStart ?? input.period_start) ?? existing?.period_start ?? null,
    optionalUnix(input.periodEnd ?? input.period_end) ?? existing?.period_end ?? null,
    status,
    input.error != null ? String(input.error) : null
  );
  return getTicketSummary(db, ticketId);
}

function listClientTicketSummaries(db, clientId, { excludeTicketId, status = 'done' } = {}) {
  ensureTicketSummariesTable(db);
  const id = optionalPositiveId(clientId);
  if (!id) return [];
  const excludeId = optionalPositiveId(excludeTicketId);
  const rows = db
    .prepare(
      `SELECT ticket_id, client_id, chat_id, summary, model, provider, message_count,
              period_start, period_end, status, error, created_at, updated_at
       FROM ticket_summaries
       WHERE client_id = ?
         AND (? IS NULL OR status = ?)
         AND (? IS NULL OR ticket_id != ?)
       ORDER BY COALESCE(period_end, 0) DESC, ticket_id DESC`
    )
    .all(id, status, status, excludeId, excludeId);
  return rows.map(mapSummaryRow).filter((row) => String(row.summary || '').trim());
}

function saveTicketSummaryText(db, ticketId, summary, extras = {}) {
  const text = requireSummaryText(summary);
  return upsertTicketSummary(db, {
    ticketId,
    ...extras,
    summary: text,
    status: 'done',
    error: null,
  });
}

function deleteTicketSummary(db, ticketId) {
  ensureTicketSummariesTable(db);
  const id = requirePositiveTicketId(ticketId);
  const existing = getTicketSummary(db, id);
  if (!existing) return null;
  db.prepare('DELETE FROM ticket_summaries WHERE ticket_id = ?').run(id);
  return existing;
}

module.exports = {
  ensureTicketSummariesTable,
  getTicketSummary,
  hasSuccessfulTicketSummary,
  upsertTicketSummary,
  saveTicketSummaryText,
  deleteTicketSummary,
  listClientTicketSummaries,
};
