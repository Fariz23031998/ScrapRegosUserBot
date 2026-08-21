const MAX_CATEGORY_NAME = 100;

const KIND_CONFIG = {
  device: {
    categoryTable: 'device_categories',
    entityTable: 'devices',
    invalidCode: 'INVALID_DEVICE_CATEGORY',
  },
  service: {
    categoryTable: 'service_categories',
    entityTable: 'services',
    invalidCode: 'INVALID_SERVICE_CATEGORY',
  },
  finance: {
    categoryTable: 'finance_categories',
    entityTable: 'account_payments',
    invalidCode: 'INVALID_FINANCE_CATEGORY',
  },
};

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function ensureColumn(db, table, column, ddl) {
  if (!tableExists(db, table)) return;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col) => col.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function getKindConfig(kind) {
  const config = KIND_CONFIG[kind];
  if (!config) throw new Error('INVALID_CATEGORY_KIND');
  return config;
}

function mapCategory(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function ensureCatalogCategoryTables(db, kind) {
  const { categoryTable, entityTable } = getKindConfig(kind);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${categoryTable} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  ensureColumn(db, entityTable, 'category_id', 'INTEGER');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_${entityTable}_category_id ON ${entityTable}(category_id);
  `);
}

function normalizeCategoryInput(input = {}) {
  const name = String(input.name || '').trim();
  if (!name || name.length > MAX_CATEGORY_NAME) throw new Error('INVALID_CATEGORY_NAME');
  return { name };
}

function listCatalogCategories(db, kind) {
  const { categoryTable } = getKindConfig(kind);
  ensureCatalogCategoryTables(db, kind);
  return db
    .prepare(
      `SELECT id, name, created_at, updated_at
       FROM ${categoryTable}
       ORDER BY name COLLATE NOCASE ASC, id ASC`
    )
    .all()
    .map(mapCategory);
}

function getCatalogCategory(db, kind, id) {
  const { categoryTable } = getKindConfig(kind);
  ensureCatalogCategoryTables(db, kind);
  const categoryId = Number(id);
  if (!Number.isFinite(categoryId) || categoryId <= 0) return null;
  return mapCategory(
    db
      .prepare(`SELECT id, name, created_at, updated_at FROM ${categoryTable} WHERE id = ?`)
      .get(categoryId)
  );
}

function createCatalogCategory(db, kind, input) {
  const { categoryTable } = getKindConfig(kind);
  ensureCatalogCategoryTables(db, kind);
  const category = normalizeCategoryInput(input);
  const result = db
    .prepare(
      `INSERT INTO ${categoryTable} (name, created_at, updated_at)
       VALUES (?, datetime('now'), datetime('now'))`
    )
    .run(category.name);
  return getCatalogCategory(db, kind, Number(result.lastInsertRowid));
}

function updateCatalogCategory(db, kind, id, input = {}) {
  const { categoryTable } = getKindConfig(kind);
  const current = getCatalogCategory(db, kind, id);
  if (!current) throw new Error('NOT_FOUND');
  const category = normalizeCategoryInput({
    name: input.name != null ? input.name : current.name,
  });
  db.prepare(`UPDATE ${categoryTable} SET name = ?, updated_at = datetime('now') WHERE id = ?`).run(
    category.name,
    current.id
  );
  return getCatalogCategory(db, kind, current.id);
}

function deleteCatalogCategory(db, kind, id) {
  const { categoryTable, entityTable } = getKindConfig(kind);
  const current = getCatalogCategory(db, kind, id);
  if (!current) return false;
  if (tableExists(db, entityTable)) {
    db.prepare(`UPDATE ${entityTable} SET category_id = NULL WHERE category_id = ?`).run(current.id);
  }
  db.prepare(`DELETE FROM ${categoryTable} WHERE id = ?`).run(current.id);
  return true;
}

function resolveCatalogCategoryId(db, kind, value) {
  const { invalidCode } = getKindConfig(kind);
  if (value == null || value === '' || value === 0 || value === '0') return null;
  const categoryId = Number(value);
  if (!Number.isFinite(categoryId) || categoryId <= 0) throw new Error(invalidCode);
  const category = getCatalogCategory(db, kind, categoryId);
  if (!category) throw new Error(invalidCode);
  return category.id;
}

function parseCategoryFilter(value) {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  if (raw === 'none' || raw === 'uncategorized') return 'none';
  const categoryId = Number(raw);
  if (!Number.isFinite(categoryId) || categoryId <= 0) return undefined;
  return categoryId;
}

function appendCategoryFilter(where, params, alias, categoryId) {
  if (categoryId === 'none') {
    where.push(`${alias}.category_id IS NULL`);
    return;
  }
  if (categoryId) {
    where.push(`${alias}.category_id = ?`);
    params.push(Number(categoryId));
  }
}

function mapCategoryFields(row) {
  return {
    category_id: row.category_id ?? null,
    category: row.category_id ? { id: row.category_id, name: row.category_name || '' } : null,
  };
}

module.exports = {
  MAX_CATEGORY_NAME,
  ensureCatalogCategoryTables,
  listCatalogCategories,
  getCatalogCategory,
  createCatalogCategory,
  updateCatalogCategory,
  deleteCatalogCategory,
  resolveCatalogCategoryId,
  parseCategoryFilter,
  appendCategoryFilter,
  mapCategoryFields,
};
