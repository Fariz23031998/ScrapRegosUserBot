const crypto = require('crypto');
const { ensurePrintTemplateTables } = require('./print-templates');

function ensureColumn(db, table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return true;
}

function ensurePrintJobTables(db) {
  ensurePrintTemplateTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      template_id TEXT NOT NULL,
      copies INTEGER NOT NULL DEFAULT 1,
      location_id INTEGER,
      printer_name TEXT,
      station_id TEXT,
      data_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_print_jobs_location ON print_jobs(location_id, status);
  `);
  ensureColumn(db, 'print_jobs', 'printer_name', 'TEXT');
  ensureColumn(db, 'print_jobs', 'station_id', 'TEXT');
}

function mapJob(row) {
  if (!row) return null;
  let data = {};
  try {
    data = JSON.parse(row.data_json || '{}');
  } catch {
    data = {};
  }
  return {
    id: row.id,
    kind: row.kind,
    printerName: row.printer_name || '',
    stationId: row.station_id || '',
    templateId: row.template_id,
    copies: Number(row.copies) || 1,
    locationId: row.location_id == null ? null : String(row.location_id),
    data,
    status: row.status,
    error: row.error || null,
    created_at: row.created_at,
    finished_at: row.finished_at || null,
  };
}

function protocolJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    kind: job.kind,
    printerName: job.printerName || undefined,
    templateId: job.templateId,
    copies: job.copies,
    data: job.data,
  };
}

function createPrintJob(db, input = {}) {
  ensurePrintJobTables(db);
  const kind = String(input.kind || '').trim().toLowerCase();
  if (!['label', 'receipt', 'invoice'].includes(kind)) throw new Error('INVALID_PRINT_KIND');
  const templateId = String(input.templateId || input.template_id || kind).trim() || kind;
  const copies = Math.max(1, Math.min(99, Math.trunc(Number(input.copies) || 1)));
  const locationId = input.location_id == null || input.location_id === '' ? null : Number(input.location_id);
  const printerName = String(input.printerName || input.printer_name || '').trim();
  const stationId = String(input.stationId || input.station_id || '').trim();
  const id = String(input.id || crypto.randomUUID());
  const data = input.data && typeof input.data === 'object' ? input.data : {};
  db.prepare(
    `INSERT INTO print_jobs (id, kind, template_id, copies, location_id, printer_name, station_id, data_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`
  ).run(
    id,
    kind,
    templateId,
    copies,
    Number.isFinite(locationId) ? locationId : null,
    printerName || null,
    stationId || null,
    JSON.stringify(data)
  );
  return getPrintJob(db, id);
}

function getPrintJob(db, id) {
  ensurePrintJobTables(db);
  return mapJob(db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(id));
}

function listPendingPrintJobs(db, locationId) {
  ensurePrintJobTables(db);
  const rows = db
    .prepare(
      `SELECT * FROM print_jobs
       WHERE status = 'pending'
       ORDER BY datetime(created_at) ASC`
    )
    .all();
  return rows
    .map(mapJob)
    .filter((job) => {
      if (locationId == null || locationId === '') return true;
      if (job.locationId == null || job.locationId === '') return true;
      return String(job.locationId) === String(locationId);
    });
}

function markPrintJobResult(db, id, ok, error) {
  ensurePrintJobTables(db);
  const job = getPrintJob(db, id);
  if (!job) return null;
  db.prepare(
    `UPDATE print_jobs
     SET status = ?, error = ?, finished_at = datetime('now')
     WHERE id = ?`
  ).run(ok ? 'printed' : 'failed', ok ? null : String(error || 'failed'), id);
  return getPrintJob(db, id);
}

module.exports = {
  ensurePrintJobTables,
  createPrintJob,
  getPrintJob,
  listPendingPrintJobs,
  markPrintJobResult,
  protocolJob,
};
