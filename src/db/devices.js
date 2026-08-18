const { getUsdUzsRate, normalizeMoneyInput, presentMoneyFields } = require('./money');
const { normalizeCatalogStaffInput, presentCatalogStaffFields } = require('./catalog-staff');
const { attachCatalogImages, deleteCatalogImagesForEntity, ensureCatalogImageTables } = require('./catalog-images');
const {
  appendCategoryFilter,
  ensureCatalogCategoryTables,
  mapCategoryFields,
  resolveCatalogCategoryId,
} = require('./catalog-categories');

const MAX_NAME = 200;
const MAX_DESCRIPTION = 2000;
const DEVICE_SELECT = `
  d.id, d.name, d.description, d.cost_amount, d.cost_currency, d.price_uzs, d.price_usd,
  d.manager_sale_percent, d.technician_score,
  d.category_id, d.created_at, d.updated_at, c.name AS category_name
`;

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col) => col.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function ensureDeviceTables(db) {
  ensureCatalogImageTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_devices_updated_at ON devices(updated_at);
  `);
  ensureColumn(db, 'devices', 'cost_amount', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'devices', 'cost_currency', "TEXT NOT NULL DEFAULT 'UZS'");
  ensureColumn(db, 'devices', 'price_uzs', 'REAL');
  ensureColumn(db, 'devices', 'price_usd', 'REAL');
  ensureColumn(db, 'devices', 'manager_sale_percent', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'devices', 'technician_score', 'REAL NOT NULL DEFAULT 0');
  db.exec(`
    UPDATE devices
    SET price_uzs = 0
    WHERE price_uzs IS NULL AND price_usd IS NULL
  `);
  ensureCatalogCategoryTables(db, 'device');
}

function mapDevice(row, rate) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    ...mapCategoryFields(row),
    ...presentMoneyFields(row, rate),
    ...presentCatalogStaffFields(row),
    images: [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeDeviceInput(db, input = {}) {
  const name = String(input.name || '').trim();
  const description = String(input.description || '').trim();
  if (!name || name.length > MAX_NAME) throw new Error('INVALID_DEVICE_NAME');
  if (description.length > MAX_DESCRIPTION) throw new Error('INVALID_DEVICE_DESCRIPTION');
  return {
    name,
    description: description || null,
    category_id: resolveCatalogCategoryId(db, 'device', input.category_id),
    ...normalizeMoneyInput(input),
    ...normalizeCatalogStaffInput(input),
  };
}

function getDevice(db, id) {
  ensureDeviceTables(db);
  const deviceId = Number(id);
  if (!Number.isFinite(deviceId) || deviceId <= 0) return null;
  const rate = getUsdUzsRate(db);
  const device = mapDevice(
    db
      .prepare(
        `SELECT ${DEVICE_SELECT}
         FROM devices d
         LEFT JOIN device_categories c ON c.id = d.category_id
         WHERE d.id = ?`
      )
      .get(deviceId),
    rate
  );
  if (device) attachCatalogImages(db, [device], 'device');
  return device;
}

function countDeviceUsage(db, deviceId) {
  if (!tableExists(db, 'task_devices')) return 0;
  return db.prepare('SELECT COUNT(*) AS count FROM task_devices WHERE device_id = ?').get(deviceId).count;
}

function listDevices(db, { query, categoryId, limit = 25, offset = 0 } = {}) {
  ensureDeviceTables(db);
  const rate = getUsdUzsRate(db);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const trimmed = String(query || '').trim();
  const params = [];
  const where = [];
  if (trimmed) {
    where.push("(d.name LIKE ? OR IFNULL(d.description, '') LIKE ?)");
    const like = `%${trimmed}%`;
    params.push(like, like);
  }
  appendCategoryFilter(where, params, 'd', categoryId);
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS count FROM devices d${whereSql}`).get(...params).count;
  const devices = db
    .prepare(
      `SELECT ${DEVICE_SELECT}
       FROM devices d
       LEFT JOIN device_categories c ON c.id = d.category_id
       ${whereSql}
       ORDER BY d.name COLLATE NOCASE ASC, d.id ASC
       LIMIT ? OFFSET ?`
    )
    .all(...params, safeLimit, safeOffset)
    .map((row) => mapDevice(row, rate));
  attachCatalogImages(db, devices, 'device');
  return { devices, total };
}

function createDevice(db, input) {
  ensureDeviceTables(db);
  const device = normalizeDeviceInput(db, input);
  const result = db
    .prepare(
      `INSERT INTO devices (
         name, description, category_id, cost_amount, cost_currency, price_uzs, price_usd,
         manager_sale_percent, technician_score, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .run(
      device.name,
      device.description,
      device.category_id,
      device.cost_amount,
      device.cost_currency,
      device.price_uzs,
      device.price_usd,
      device.manager_sale_percent,
      device.technician_score
    );
  return getDevice(db, Number(result.lastInsertRowid));
}

function updateDevice(db, id, input = {}) {
  const current = getDevice(db, id);
  if (!current) throw new Error('NOT_FOUND');
  const device = normalizeDeviceInput(db, {
    name: input.name != null ? input.name : current.name,
    description: input.description != null ? input.description : current.description,
    category_id: input.category_id !== undefined ? input.category_id : current.category_id,
    cost_amount: input.cost_amount != null ? input.cost_amount : current.cost_amount,
    cost_currency: input.cost_currency != null ? input.cost_currency : current.cost_currency,
    price_uzs: input.price_uzs !== undefined ? input.price_uzs : current.price_uzs,
    price_usd: input.price_usd !== undefined ? input.price_usd : current.price_usd,
    manager_sale_percent:
      input.manager_sale_percent !== undefined ? input.manager_sale_percent : current.manager_sale_percent,
    technician_score: input.technician_score !== undefined ? input.technician_score : current.technician_score,
  });
  db.prepare(
    `UPDATE devices
     SET name = ?, description = ?, category_id = ?, cost_amount = ?, cost_currency = ?,
         price_uzs = ?, price_usd = ?, manager_sale_percent = ?, technician_score = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    device.name,
    device.description,
    device.category_id,
    device.cost_amount,
    device.cost_currency,
    device.price_uzs,
    device.price_usd,
    device.manager_sale_percent,
    device.technician_score,
    current.id
  );
  return getDevice(db, current.id);
}

function deleteDevice(db, id) {
  const current = getDevice(db, id);
  if (!current) return false;
  if (countDeviceUsage(db, current.id) > 0) throw new Error('DEVICE_IN_USE');
  deleteCatalogImagesForEntity(db, 'device', current.id);
  db.prepare('DELETE FROM devices WHERE id = ?').run(current.id);
  return true;
}

module.exports = {
  ensureDeviceTables,
  getDevice,
  listDevices,
  createDevice,
  updateDevice,
  deleteDevice,
};
