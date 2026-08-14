const EXTRACTION_KINDS = new Set(['audio', 'image']);

function ensureChatFileExtractionsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_chat_file_extractions (
      file_id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      name TEXT,
      mime_type TEXT,
      bytes INTEGER,
      model TEXT,
      source TEXT,
      ticket_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ai_chat_file_extractions_ticket_id
      ON ai_chat_file_extractions(ticket_id);
  `);
}

function optionalPositiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function optionalNonNegativeInt(value) {
  const num = Number(value);
  return Number.isInteger(num) && num >= 0 ? num : null;
}

function normalizeKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  return EXTRACTION_KINDS.has(kind) ? kind : null;
}

function mapExtractionRow(row) {
  if (!row) return null;
  return {
    file_id: Number(row.file_id),
    kind: String(row.kind || ''),
    text: String(row.text || ''),
    name: row.name ? String(row.name) : null,
    mime_type: row.mime_type ? String(row.mime_type) : null,
    bytes: optionalNonNegativeInt(row.bytes),
    model: row.model || null,
    source: row.source || null,
    ticket_id: optionalPositiveId(row.ticket_id),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function getChatFileExtraction(db, fileId) {
  ensureChatFileExtractionsTable(db);
  const id = optionalPositiveId(fileId);
  if (!id) return null;
  const row = db
    .prepare(
      `SELECT file_id, kind, text, name, mime_type, bytes, model, source, ticket_id,
              created_at, updated_at
       FROM ai_chat_file_extractions
       WHERE file_id = ?`
    )
    .get(id);
  return mapExtractionRow(row);
}

function listChatFileExtractions(db, fileIds) {
  ensureChatFileExtractionsTable(db);
  const ids = [...new Set((fileIds || []).map(optionalPositiveId).filter(Boolean))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT file_id, kind, text, name, mime_type, bytes, model, source, ticket_id,
              created_at, updated_at
       FROM ai_chat_file_extractions
       WHERE file_id IN (${placeholders})`
    )
    .all(...ids);
  return rows.map(mapExtractionRow).filter((row) => String(row.text || '').trim());
}

function extractionsByFileId(db, fileIds) {
  return new Map(listChatFileExtractions(db, fileIds).map((row) => [row.file_id, row]));
}

function upsertChatFileExtraction(db, input = {}) {
  ensureChatFileExtractionsTable(db);
  const fileId = optionalPositiveId(input.fileId ?? input.file_id);
  if (!fileId) return null;
  const kind = normalizeKind(input.kind);
  const text = String(input.text || '').trim();
  if (!kind || !text) return null;

  const existing = getChatFileExtraction(db, fileId);
  db.prepare(
    `INSERT INTO ai_chat_file_extractions (
       file_id, kind, text, name, mime_type, bytes, model, source, ticket_id,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(file_id) DO UPDATE SET
       kind = excluded.kind,
       text = excluded.text,
       name = COALESCE(excluded.name, ai_chat_file_extractions.name),
       mime_type = COALESCE(excluded.mime_type, ai_chat_file_extractions.mime_type),
       bytes = COALESCE(excluded.bytes, ai_chat_file_extractions.bytes),
       model = COALESCE(excluded.model, ai_chat_file_extractions.model),
       source = COALESCE(excluded.source, ai_chat_file_extractions.source),
       ticket_id = COALESCE(excluded.ticket_id, ai_chat_file_extractions.ticket_id),
       updated_at = datetime('now')`
  ).run(
    fileId,
    kind,
    text,
    input.name != null ? String(input.name).trim() || null : existing?.name ?? null,
    input.mimeType != null || input.mime_type != null
      ? String(input.mimeType ?? input.mime_type ?? '').trim() || null
      : existing?.mime_type ?? null,
    optionalNonNegativeInt(input.bytes) ?? existing?.bytes ?? null,
    input.model != null ? String(input.model) : existing?.model ?? null,
    input.source != null ? String(input.source).trim() || null : existing?.source ?? null,
    optionalPositiveId(input.ticketId ?? input.ticket_id) ?? existing?.ticket_id ?? null
  );
  return getChatFileExtraction(db, fileId);
}

module.exports = {
  ensureChatFileExtractionsTable,
  getChatFileExtraction,
  listChatFileExtractions,
  extractionsByFileId,
  upsertChatFileExtraction,
};
