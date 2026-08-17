const fs = require('fs');
const path = require('path');
const { fromRoot } = require('../paths');

const ENTITY_TYPES = new Set(['device', 'service']);
const MAX_IMAGES_PER_ENTITY = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ORIGINAL_NAME = 200;
const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

function getCatalogImagesRoot() {
  const override = String(process.env.CATALOG_IMAGES_DIR || '').trim();
  if (override) return path.resolve(override);
  return fromRoot('data', 'catalog-images');
}

function ensureCatalogImageTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT,
      mime TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_catalog_images_entity
      ON catalog_images(entity_type, entity_id, sort_order, id);
  `);
}

function normalizeEntityType(entityType) {
  const value = String(entityType || '').trim();
  if (!ENTITY_TYPES.has(value)) throw new Error('INVALID_IMAGE_ENTITY');
  return value;
}

function normalizeEntityId(entityId) {
  const id = Number(entityId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('NOT_FOUND');
  return id;
}

function catalogImageUrl(entityType, entityId, imageId) {
  const collection = entityType === 'service' ? 'services' : 'devices';
  return `/bot-admin/api/${collection}/${entityId}/images/${imageId}`;
}

function mapImage(row) {
  if (!row) return null;
  return {
    id: row.id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    filename: row.filename,
    original_name: row.original_name || '',
    mime: row.mime,
    sort_order: row.sort_order ?? 0,
    url: catalogImageUrl(row.entity_type, row.entity_id, row.id),
    created_at: row.created_at,
  };
}

function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { mime: 'image/gif', ext: 'gif' };
  }
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

function entityDir(entityType, entityId) {
  return path.join(getCatalogImagesRoot(), entityType, String(entityId));
}

function imageFilePath(row) {
  return path.join(entityDir(row.entity_type, row.entity_id), row.filename);
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function nextSortOrder(db, entityType, entityId) {
  const row = db
    .prepare(
      `SELECT MAX(sort_order) AS max_order
       FROM catalog_images
       WHERE entity_type = ? AND entity_id = ?`
    )
    .get(entityType, entityId);
  if (row?.max_order == null) return 0;
  return Number(row.max_order) + 1;
}

function countCatalogImages(db, entityType, entityId) {
  ensureCatalogImageTables(db);
  const type = normalizeEntityType(entityType);
  const id = normalizeEntityId(entityId);
  return db
    .prepare('SELECT COUNT(*) AS count FROM catalog_images WHERE entity_type = ? AND entity_id = ?')
    .get(type, id).count;
}

function listCatalogImages(db, entityType, entityId) {
  ensureCatalogImageTables(db);
  const type = normalizeEntityType(entityType);
  const id = normalizeEntityId(entityId);
  return db
    .prepare(
      `SELECT * FROM catalog_images
       WHERE entity_type = ? AND entity_id = ?
       ORDER BY sort_order ASC, id ASC`
    )
    .all(type, id)
    .map(mapImage);
}

function listCatalogImagesForEntities(db, entityType, entityIds) {
  ensureCatalogImageTables(db);
  const type = normalizeEntityType(entityType);
  const ids = [...new Set((entityIds || []).map((value) => Number(value)).filter((id) => Number.isFinite(id) && id > 0))];
  const map = new Map();
  if (!ids.length) return map;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT * FROM catalog_images
       WHERE entity_type = ? AND entity_id IN (${placeholders})
       ORDER BY sort_order ASC, id ASC`
    )
    .all(type, ...ids);
  for (const row of rows) {
    const list = map.get(row.entity_id) || [];
    list.push(mapImage(row));
    map.set(row.entity_id, list);
  }
  return map;
}

function attachCatalogImages(db, items, entityType, idKey = 'id') {
  const list = Array.isArray(items) ? items : [];
  const ids = list.map((item) => Number(item?.[idKey]));
  const map = listCatalogImagesForEntities(db, entityType, ids);
  for (const item of list) {
    if (!item) continue;
    item.images = map.get(Number(item[idKey])) || [];
  }
  return list;
}

function getCatalogImage(db, entityType, entityId, imageId) {
  ensureCatalogImageTables(db);
  const type = normalizeEntityType(entityType);
  const id = normalizeEntityId(entityId);
  const parsedImageId = Number(imageId);
  if (!Number.isFinite(parsedImageId) || parsedImageId <= 0) return null;
  const row = db
    .prepare(
      `SELECT * FROM catalog_images
       WHERE id = ? AND entity_type = ? AND entity_id = ?`
    )
    .get(parsedImageId, type, id);
  return row || null;
}

function addCatalogImage(db, entityType, entityId, input = {}) {
  ensureCatalogImageTables(db);
  const type = normalizeEntityType(entityType);
  const id = normalizeEntityId(entityId);
  const buffer = input.buffer;
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('INVALID_IMAGE_TYPE');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('INVALID_IMAGE_SIZE');

  const sniffed = sniffImage(buffer);
  if (!sniffed) throw new Error('INVALID_IMAGE_TYPE');

  const existing = countCatalogImages(db, type, id);
  if (existing >= MAX_IMAGES_PER_ENTITY) throw new Error('IMAGE_LIMIT_REACHED');

  const originalName = String(input.originalName || input.original_name || '')
    .trim()
    .slice(0, MAX_ORIGINAL_NAME);
  const sortOrder = nextSortOrder(db, type, id);
  const result = db
    .prepare(
      `INSERT INTO catalog_images (
         entity_type, entity_id, filename, original_name, mime, sort_order, created_at
       ) VALUES (?, ?, '', ?, ?, ?, datetime('now'))`
    )
    .run(type, id, originalName || null, sniffed.mime, sortOrder);
  const imageId = Number(result.lastInsertRowid);
  const filename = `${imageId}.${sniffed.ext}`;
  const dir = entityDir(type, id);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  try {
    fs.writeFileSync(filePath, buffer);
    db.prepare('UPDATE catalog_images SET filename = ? WHERE id = ?').run(filename, imageId);
  } catch (error) {
    db.prepare('DELETE FROM catalog_images WHERE id = ?').run(imageId);
    safeUnlink(filePath);
    throw error;
  }
  return mapImage(db.prepare('SELECT * FROM catalog_images WHERE id = ?').get(imageId));
}

function deleteCatalogImage(db, entityType, entityId, imageId) {
  const row = getCatalogImage(db, entityType, entityId, imageId);
  if (!row) throw new Error('NOT_FOUND');
  db.prepare('DELETE FROM catalog_images WHERE id = ?').run(row.id);
  safeUnlink(imageFilePath(row));
  return true;
}

function deleteCatalogImagesForEntity(db, entityType, entityId) {
  ensureCatalogImageTables(db);
  const type = normalizeEntityType(entityType);
  const id = normalizeEntityId(entityId);
  const rows = db
    .prepare('SELECT * FROM catalog_images WHERE entity_type = ? AND entity_id = ?')
    .all(type, id);
  db.prepare('DELETE FROM catalog_images WHERE entity_type = ? AND entity_id = ?').run(type, id);
  for (const row of rows) {
    safeUnlink(imageFilePath(row));
  }
  try {
    fs.rmdirSync(entityDir(type, id));
  } catch {
    // directory may be missing or not empty
  }
  return rows.length;
}

function resolveCatalogImageFile(row) {
  if (!row?.filename) return null;
  const filePath = imageFilePath(row);
  if (!fs.existsSync(filePath)) return null;
  const ext = path.extname(row.filename).slice(1).toLowerCase();
  return {
    filePath,
    mime: row.mime || MIME_BY_EXT[ext] || 'application/octet-stream',
    originalName: row.original_name || row.filename,
  };
}

module.exports = {
  MAX_IMAGES_PER_ENTITY,
  MAX_IMAGE_BYTES,
  ensureCatalogImageTables,
  getCatalogImagesRoot,
  catalogImageUrl,
  countCatalogImages,
  listCatalogImages,
  listCatalogImagesForEntities,
  attachCatalogImages,
  getCatalogImage,
  addCatalogImage,
  deleteCatalogImage,
  deleteCatalogImagesForEntity,
  resolveCatalogImageFile,
};
