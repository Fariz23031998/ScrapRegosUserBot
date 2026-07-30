const { PRICE_COLUMNS, DEFAULT_SERVICE_PRICES_CATALOG } = require('./service-prices-seed');

const MAX_TITLE = 200;
const MAX_NOTICE = 1000;
const MAX_NAME = 300;
const MAX_PRICE = 80;
const MAX_CATEGORIES = 50;
const MAX_ITEMS_PER_CATEGORY = 100;

function ensureServicePricesTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_price_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      title_ru TEXT NOT NULL,
      title_uz TEXT NOT NULL,
      notice_ru TEXT NOT NULL,
      notice_uz TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS service_price_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sort_order INTEGER NOT NULL,
      name_ru TEXT NOT NULL,
      name_uz TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS service_price_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      sort_order INTEGER NOT NULL,
      name_ru TEXT NOT NULL,
      name_uz TEXT NOT NULL,
      price_fixed TEXT,
      price_min5 TEXT,
      price_min30 TEXT,
      price_hour1 TEXT,
      price_hour2 TEXT,
      FOREIGN KEY (category_id) REFERENCES service_price_categories(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_service_price_categories_sort
      ON service_price_categories(sort_order);
    CREATE INDEX IF NOT EXISTS idx_service_price_items_category_sort
      ON service_price_items(category_id, sort_order);
  `);

  seedDefaultCatalogIfEmpty(db);
}

function seedDefaultCatalogIfEmpty(db) {
  const meta = db.prepare('SELECT id FROM service_price_meta WHERE id = 1').get();
  if (meta) return;
  replaceServicePricesCatalog(db, DEFAULT_SERVICE_PRICES_CATALOG, { skipEnsure: true });
}

function normalizeText(value, { max, allowEmpty = false } = {}) {
  const text = String(value ?? '').trim();
  if (!allowEmpty && !text) {
    throw new Error('INVALID_TEXT');
  }
  if (text.length > max) {
    throw new Error('INVALID_TEXT');
  }
  return text;
}

function normalizePrice(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > MAX_PRICE) {
    throw new Error('INVALID_PRICE');
  }
  return text;
}

function mapItemRow(row) {
  return {
    id: row.id,
    sort_order: Number(row.sort_order),
    name_ru: row.name_ru,
    name_uz: row.name_uz,
    prices: {
      fixed: row.price_fixed,
      min5: row.price_min5,
      min30: row.price_min30,
      hour1: row.price_hour1,
      hour2: row.price_hour2,
    },
  };
}

function getServicePricesCatalog(db) {
  ensureServicePricesTables(db);

  const meta = db
    .prepare(
      `SELECT title_ru, title_uz, notice_ru, notice_uz, updated_at
       FROM service_price_meta
       WHERE id = 1`
    )
    .get();

  const categories = db
    .prepare(
      `SELECT id, sort_order, name_ru, name_uz
       FROM service_price_categories
       ORDER BY sort_order ASC, id ASC`
    )
    .all();

  const itemsByCategory = new Map();
  for (const category of categories) {
    itemsByCategory.set(category.id, []);
  }

  const itemRows = db
    .prepare(
      `SELECT id, category_id, sort_order, name_ru, name_uz,
              price_fixed, price_min5, price_min30, price_hour1, price_hour2
       FROM service_price_items
       ORDER BY sort_order ASC, id ASC`
    )
    .all();

  for (const row of itemRows) {
    const bucket = itemsByCategory.get(row.category_id);
    if (bucket) bucket.push(mapItemRow(row));
  }

  return {
    title_ru: meta.title_ru,
    title_uz: meta.title_uz,
    notice_ru: meta.notice_ru,
    notice_uz: meta.notice_uz,
    updated_at: meta.updated_at,
    columns: PRICE_COLUMNS,
    categories: categories.map((category) => ({
      id: category.id,
      sort_order: Number(category.sort_order),
      name_ru: category.name_ru,
      name_uz: category.name_uz,
      items: itemsByCategory.get(category.id) || [],
    })),
  };
}

function validateCatalogInput(input = {}) {
  const title_ru = normalizeText(input.title_ru, { max: MAX_TITLE });
  const title_uz = normalizeText(input.title_uz, { max: MAX_TITLE });
  const notice_ru = normalizeText(input.notice_ru, { max: MAX_NOTICE });
  const notice_uz = normalizeText(input.notice_uz, { max: MAX_NOTICE });

  if (!Array.isArray(input.categories) || input.categories.length === 0) {
    throw new Error('NO_CATEGORIES');
  }
  if (input.categories.length > MAX_CATEGORIES) {
    throw new Error('TOO_MANY_CATEGORIES');
  }

  const categories = input.categories.map((category, categoryIndex) => {
    const itemsInput = Array.isArray(category?.items) ? category.items : [];
    if (itemsInput.length === 0) {
      throw new Error('NO_ITEMS');
    }
    if (itemsInput.length > MAX_ITEMS_PER_CATEGORY) {
      throw new Error('TOO_MANY_ITEMS');
    }

    const items = itemsInput.map((item, itemIndex) => {
      const prices = item?.prices || {};
      return {
        sort_order: itemIndex,
        name_ru: normalizeText(item?.name_ru, { max: MAX_NAME }),
        name_uz: normalizeText(item?.name_uz, { max: MAX_NAME }),
        price_fixed: normalizePrice(prices.fixed ?? item?.price_fixed),
        price_min5: normalizePrice(prices.min5 ?? item?.price_min5),
        price_min30: normalizePrice(prices.min30 ?? item?.price_min30),
        price_hour1: normalizePrice(prices.hour1 ?? item?.price_hour1),
        price_hour2: normalizePrice(prices.hour2 ?? item?.price_hour2),
      };
    });

    return {
      sort_order: categoryIndex,
      name_ru: normalizeText(category?.name_ru, { max: MAX_NAME }),
      name_uz: normalizeText(category?.name_uz, { max: MAX_NAME }),
      items,
    };
  });

  return { title_ru, title_uz, notice_ru, notice_uz, categories };
}

function replaceServicePricesCatalog(db, input, { skipEnsure = false } = {}) {
  if (!skipEnsure) {
    ensureServicePricesTables(db);
  }

  const catalog = validateCatalogInput(input);

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM service_price_items').run();
    db.prepare('DELETE FROM service_price_categories').run();
    db.prepare('DELETE FROM service_price_meta').run();

    db.prepare(
      `INSERT INTO service_price_meta (
         id, title_ru, title_uz, notice_ru, notice_uz, updated_at
       ) VALUES (1, ?, ?, ?, ?, datetime('now'))`
    ).run(catalog.title_ru, catalog.title_uz, catalog.notice_ru, catalog.notice_uz);

    const insertCategory = db.prepare(
      `INSERT INTO service_price_categories (sort_order, name_ru, name_uz)
       VALUES (?, ?, ?)`
    );
    const insertItem = db.prepare(
      `INSERT INTO service_price_items (
         category_id, sort_order, name_ru, name_uz,
         price_fixed, price_min5, price_min30, price_hour1, price_hour2
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const category of catalog.categories) {
      const result = insertCategory.run(category.sort_order, category.name_ru, category.name_uz);
      const categoryId = Number(result.lastInsertRowid);
      for (const item of category.items) {
        insertItem.run(
          categoryId,
          item.sort_order,
          item.name_ru,
          item.name_uz,
          item.price_fixed,
          item.price_min5,
          item.price_min30,
          item.price_hour1,
          item.price_hour2
        );
      }
    }

    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  }

  return getServicePricesCatalog(db);
}

module.exports = {
  PRICE_COLUMNS,
  DEFAULT_SERVICE_PRICES_CATALOG,
  ensureServicePricesTables,
  getServicePricesCatalog,
  replaceServicePricesCatalog,
  validateCatalogInput,
};
