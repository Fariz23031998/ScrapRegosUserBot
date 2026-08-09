function ensureTicketRecordingsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_recordings (
      ticket_id INTEGER PRIMARY KEY,
      recording_url TEXT,
      duration_seconds REAL,
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

function mapRecordingRow(row) {
  if (!row) return null;
  return {
    ticket_id: Number(row.ticket_id),
    recording_url: row.recording_url || null,
    duration_seconds:
      row.duration_seconds == null || !Number.isFinite(Number(row.duration_seconds))
        ? null
        : Number(row.duration_seconds),
    updated_at: row.updated_at || null,
  };
}

function getTicketRecording(db, ticketId) {
  ensureTicketRecordingsTable(db);
  const id = Number(ticketId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db
    .prepare(
      `SELECT ticket_id, recording_url, duration_seconds, updated_at
       FROM ticket_recordings
       WHERE ticket_id = ?`
    )
    .get(id);
  return mapRecordingRow(row);
}

function getTicketRecordingsByIds(db, ticketIds) {
  ensureTicketRecordingsTable(db);
  const ids = [...new Set((ticketIds || []).map(Number))]
    .filter((id) => Number.isInteger(id) && id > 0);
  const byId = new Map();
  if (ids.length === 0) return byId;

  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT ticket_id, recording_url, duration_seconds, updated_at
       FROM ticket_recordings
       WHERE ticket_id IN (${placeholders})`
    )
    .all(...ids);

  for (const row of rows) {
    const mapped = mapRecordingRow(row);
    if (mapped) byId.set(mapped.ticket_id, mapped);
  }
  return byId;
}

/**
 * Partial upsert. When recording URL changes, duration is cleared unless a new
 * duration is provided in the same call.
 */
function upsertTicketRecording(db, input = {}) {
  ensureTicketRecordingsTable(db);
  const ticketId = requirePositiveTicketId(input.ticketId ?? input.ticket_id);
  const existing = getTicketRecording(db, ticketId);

  const urlProvided = Object.prototype.hasOwnProperty.call(input, 'recordingUrl')
    || Object.prototype.hasOwnProperty.call(input, 'recording_url');
  const durationProvided = Object.prototype.hasOwnProperty.call(input, 'durationSeconds')
    || Object.prototype.hasOwnProperty.call(input, 'duration_seconds');

  let nextUrl = existing?.recording_url ?? null;
  let nextDuration = existing?.duration_seconds ?? null;

  if (urlProvided) {
    const raw = input.recordingUrl ?? input.recording_url;
    nextUrl = raw == null || raw === '' ? null : String(raw);
    if ((existing?.recording_url || null) !== nextUrl) {
      nextDuration = null;
    }
  }

  if (durationProvided) {
    const raw = input.durationSeconds ?? input.duration_seconds;
    nextDuration =
      raw == null || raw === '' || !Number.isFinite(Number(raw)) ? null : Number(raw);
  }

  db.prepare(
    `INSERT INTO ticket_recordings (ticket_id, recording_url, duration_seconds, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(ticket_id) DO UPDATE SET
       recording_url = excluded.recording_url,
       duration_seconds = excluded.duration_seconds,
       updated_at = datetime('now')`
  ).run(ticketId, nextUrl, nextDuration);

  return getTicketRecording(db, ticketId);
}

function listTicketRecordingsMissingDuration(db, { limit = 100 } = {}) {
  ensureTicketRecordingsTable(db);
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  const rows = db
    .prepare(
      `SELECT ticket_id, recording_url, duration_seconds, updated_at
       FROM ticket_recordings
       WHERE recording_url IS NOT NULL
         AND recording_url != ''
         AND duration_seconds IS NULL
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .all(safeLimit);
  return rows.map(mapRecordingRow);
}

module.exports = {
  ensureTicketRecordingsTable,
  getTicketRecording,
  getTicketRecordingsByIds,
  upsertTicketRecording,
  listTicketRecordingsMissingDuration,
};
