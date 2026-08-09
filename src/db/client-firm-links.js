function ensureClientFirmLinksTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_firm_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      regos_client_id INTEGER NOT NULL,
      firm_type TEXT NOT NULL,
      firm_record_id TEXT NOT NULL,
      firm_name TEXT,
      firm_phone TEXT,
      firm_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(regos_client_id, firm_type, firm_record_id)
    );

    CREATE INDEX IF NOT EXISTS idx_client_firm_links_client
      ON client_firm_links(regos_client_id);

    CREATE INDEX IF NOT EXISTS idx_client_firm_links_firm
      ON client_firm_links(firm_type, firm_record_id);
  `);
}

function mapLinkRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    regos_client_id: Number(row.regos_client_id),
    firm_type: row.firm_type,
    firm_record_id: String(row.firm_record_id),
    firm_name: row.firm_name || null,
    firm_phone: row.firm_phone || null,
    firm_message: row.firm_message || null,
    created_at: row.created_at || null,
  };
}

function requirePositiveClientId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error('INVALID_CLIENT_ID');
    error.code = 'INVALID_CLIENT_ID';
    throw error;
  }
  return id;
}

function normalizeFirmType(value) {
  const type = String(value || '').trim();
  if (!type) {
    const error = new Error('INVALID_FIRM_TYPE');
    error.code = 'INVALID_FIRM_TYPE';
    throw error;
  }
  return type;
}

function normalizeFirmRecordId(value) {
  if (value == null || value === '') {
    const error = new Error('INVALID_FIRM_RECORD_ID');
    error.code = 'INVALID_FIRM_RECORD_ID';
    throw error;
  }
  return String(value);
}

function listLinksByClient(db, regosClientId) {
  ensureClientFirmLinksTable(db);
  const clientId = requirePositiveClientId(regosClientId);
  const rows = db
    .prepare(
      `SELECT id, regos_client_id, firm_type, firm_record_id, firm_name, firm_phone, firm_message, created_at
       FROM client_firm_links
       WHERE regos_client_id = ?
       ORDER BY created_at DESC, id DESC`
    )
    .all(clientId);
  return rows.map(mapLinkRow);
}

function listLinksByFirm(db, firmType, firmRecordId) {
  ensureClientFirmLinksTable(db);
  const type = normalizeFirmType(firmType);
  const recordId = normalizeFirmRecordId(firmRecordId);
  const rows = db
    .prepare(
      `SELECT id, regos_client_id, firm_type, firm_record_id, firm_name, firm_phone, firm_message, created_at
       FROM client_firm_links
       WHERE firm_type = ? AND firm_record_id = ?
       ORDER BY created_at DESC, id DESC`
    )
    .all(type, recordId);
  return rows.map(mapLinkRow);
}

function getLinkById(db, linkId) {
  ensureClientFirmLinksTable(db);
  const id = Number(linkId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db
    .prepare(
      `SELECT id, regos_client_id, firm_type, firm_record_id, firm_name, firm_phone, firm_message, created_at
       FROM client_firm_links
       WHERE id = ?`
    )
    .get(id);
  return mapLinkRow(row);
}

function addLink(db, input = {}) {
  ensureClientFirmLinksTable(db);
  const regosClientId = requirePositiveClientId(input.regos_client_id ?? input.regosClientId);
  const firmType = normalizeFirmType(input.firm_type ?? input.type);
  const firmRecordId = normalizeFirmRecordId(input.firm_record_id ?? input.recordId);
  const firmName =
    input.firm_name != null || input.clientName != null
      ? String(input.firm_name ?? input.clientName).trim() || null
      : null;
  const firmPhone =
    input.firm_phone != null || input.phone != null
      ? String(input.firm_phone ?? input.phone).trim() || null
      : null;
  const firmMessage =
    input.firm_message != null || input.message != null
      ? String(input.firm_message ?? input.message).trim() || null
      : null;

  try {
    const result = db
      .prepare(
        `INSERT INTO client_firm_links (
           regos_client_id, firm_type, firm_record_id, firm_name, firm_phone, firm_message
         ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(regosClientId, firmType, firmRecordId, firmName, firmPhone, firmMessage);
    return getLinkById(db, result.lastInsertRowid);
  } catch (error) {
    if (String(error?.message || '').includes('UNIQUE')) {
      const duplicate = new Error('DUPLICATE_LINK');
      duplicate.code = 'DUPLICATE_LINK';
      throw duplicate;
    }
    throw error;
  }
}

function removeLink(db, linkId, { regosClientId } = {}) {
  ensureClientFirmLinksTable(db);
  const id = Number(linkId);
  if (!Number.isInteger(id) || id <= 0) return false;

  if (regosClientId != null) {
    const clientId = requirePositiveClientId(regosClientId);
    const result = db
      .prepare('DELETE FROM client_firm_links WHERE id = ? AND regos_client_id = ?')
      .run(id, clientId);
    return result.changes > 0;
  }

  const result = db.prepare('DELETE FROM client_firm_links WHERE id = ?').run(id);
  return result.changes > 0;
}

module.exports = {
  ensureClientFirmLinksTable,
  listLinksByClient,
  listLinksByFirm,
  getLinkById,
  addLink,
  removeLink,
};
