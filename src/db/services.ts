import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { getUsdUzsRate, normalizeMoneyInput, presentMoneyFields } from './money';
import { normalizeCatalogStaffInput, presentCatalogStaffFields } from './catalog-staff';
import { attachCatalogImages, deleteCatalogImagesForEntity, ensureCatalogImageTables } from './catalog-images';
import { appendCategoryFilter, ensureCatalogCategoryTables, mapCategoryFields, resolveCatalogCategoryId } from './catalog-categories';
import { resolveListOrderBy } from './list-sort';

const MAX_NAME = 200;
const MAX_DESCRIPTION = 2000;
const SERVICE_SELECT = `
  s.id, s.name, s.description, s.cost_amount, s.cost_currency, s.price_uzs, s.price_usd,
  s.manager_sale_percent, s.technician_score,
  s.category_id, s.created_at, s.updated_at, c.name AS category_name
`;

function tableExists(db: Db, name?: any) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function ensureColumn(db: Db, table?: any, column?: any, ddl?: any) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col?: any) => col.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function ensureServiceTables(db: Db) {
  ensureCatalogImageTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      cost_amount REAL NOT NULL DEFAULT 0,
      cost_currency TEXT NOT NULL DEFAULT 'UZS',
      price_uzs REAL,
      price_usd REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_services_updated_at ON services(updated_at);
  `);
  ensureColumn(db, 'services', 'cost_amount', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'services', 'cost_currency', "TEXT NOT NULL DEFAULT 'UZS'");
  ensureColumn(db, 'services', 'price_uzs', 'REAL');
  ensureColumn(db, 'services', 'price_usd', 'REAL');
  ensureColumn(db, 'services', 'manager_sale_percent', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'services', 'technician_score', 'REAL NOT NULL DEFAULT 0');
  ensureCatalogCategoryTables(db, 'service');
}

function mapService(row?: any, rate?: any) {
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

function normalizeServiceInput(db: Db, input: any = {}) {
  const name = String(input.name || '').trim();
  const description = String(input.description || '').trim();
  if (!name || name.length > MAX_NAME) throw new Error('INVALID_SERVICE_NAME');
  if (description.length > MAX_DESCRIPTION) throw new Error('INVALID_SERVICE_DESCRIPTION');
  return {
    name,
    description: description || null,
    category_id: resolveCatalogCategoryId(db, 'service', input.category_id),
    ...normalizeMoneyInput(input),
    ...normalizeCatalogStaffInput(input),
  };
}

function getService(db: Db, id?: any) {
  ensureServiceTables(db);
  const serviceId = Number(id);
  if (!Number.isFinite(serviceId) || serviceId <= 0) return null;
  const rate = getUsdUzsRate(db);
  const service = mapService(
    db
      .prepare(
        `SELECT ${SERVICE_SELECT}
         FROM services s
         LEFT JOIN service_categories c ON c.id = s.category_id
         WHERE s.id = ?`
      )
      .get(serviceId),
    rate
  );
  if (service) attachCatalogImages(db, [service], 'service');
  return service;
}

function countServiceUsage(db: Db, serviceId?: any) {
  if (!tableExists(db, 'task_services')) return 0;
  return (db.prepare('SELECT COUNT(*) AS count FROM task_services WHERE service_id = ?').get(serviceId) as { count: number } | undefined)!.count;
}

const SERVICE_SORT_COLUMNS: Record<string, string> = {
  id: 's.id',
  name: 's.name COLLATE NOCASE',
  category: 'c.name COLLATE NOCASE',
  description: 's.description COLLATE NOCASE',
  cost: 's.cost_amount',
  price: 's.price_uzs',
  manager_sale_percent: 's.manager_sale_percent',
  technician_score: 's.technician_score',
  updated_at: 'datetime(s.updated_at)',
};

function listServices(db: Db, { query, categoryId, limit = 25, offset = 0, sort }: Unchecked = {}) {
  ensureServiceTables(db);
  const rate = getUsdUzsRate(db);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const trimmed = String(query || '').trim();
  const params: any[] = [];
  const where: any[] = [];
  if (trimmed) {
    where.push("(s.name LIKE ? OR IFNULL(s.description, '') LIKE ?)");
    const like = `%${trimmed}%`;
    params.push(like, like);
  }
  appendCategoryFilter(where, params, 's', categoryId);
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM services s${whereSql}`).get(...params) as { count: number } | undefined)!.count;
  const services = db
    .prepare(
      `SELECT ${SERVICE_SELECT}
       FROM services s
       LEFT JOIN service_categories c ON c.id = s.category_id
       ${whereSql}
       ${resolveListOrderBy(sort, SERVICE_SORT_COLUMNS, 's.id') || 'ORDER BY s.name COLLATE NOCASE ASC, s.id ASC'}
       LIMIT ? OFFSET ?`
    )
    .all(...params, safeLimit, safeOffset)
    .map((row?: any) => mapService(row, rate));
  attachCatalogImages(db, services, 'service');
  return { services, total };
}

function createService(db: Db, input?: any) {
  ensureServiceTables(db);
  const service = normalizeServiceInput(db, input);
  const result = db
    .prepare(
      `INSERT INTO services (
         name, description, category_id, cost_amount, cost_currency, price_uzs, price_usd,
         manager_sale_percent, technician_score, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .run(
      service.name,
      service.description,
      service.category_id,
      service.cost_amount,
      service.cost_currency,
      service.price_uzs,
      service.price_usd,
      service.manager_sale_percent,
      service.technician_score
    );
  return getService(db, Number(result.lastInsertRowid));
}

function updateService(db: Db, id: any, input: any = {}) {
  const current = getService(db, id);
  if (!current) throw new Error('NOT_FOUND');
  const service = normalizeServiceInput(db, {
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
    `UPDATE services
     SET name = ?, description = ?, category_id = ?, cost_amount = ?, cost_currency = ?,
         price_uzs = ?, price_usd = ?, manager_sale_percent = ?, technician_score = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    service.name,
    service.description,
    service.category_id,
    service.cost_amount,
    service.cost_currency,
    service.price_uzs,
    service.price_usd,
    service.manager_sale_percent,
    service.technician_score,
    current.id
  );
  return getService(db, current.id);
}

function deleteService(db: Db, id?: any) {
  const current = getService(db, id);
  if (!current) return false;
  if (countServiceUsage(db, current.id) > 0) throw new Error('SERVICE_IN_USE');
  deleteCatalogImagesForEntity(db, 'service', current.id);
  db.prepare('DELETE FROM services WHERE id = ?').run(current.id);
  return true;
}

export {
  ensureServiceTables,
  getService,
  listServices,
  createService,
  updateService,
  deleteService,
};
