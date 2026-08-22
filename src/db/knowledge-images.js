const dns = require('dns').promises;
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const { fromRoot } = require('../paths');

const MAX_IMAGES_PER_ARTICLE = 20;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ORIGINAL_NAME = 200;
const FETCH_TIMEOUT_MS = 15000;
const FETCH_MAX_REDIRECTS = 3;
const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

function getKnowledgeImagesRoot() {
  const override = String(process.env.KNOWLEDGE_IMAGES_DIR || '').trim();
  if (override) return path.resolve(override);
  return fromRoot('data', 'knowledge-images');
}

function ensureKnowledgeImageTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_article_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT,
      mime TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (article_id) REFERENCES knowledge_articles(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_article_images_article
      ON knowledge_article_images(article_id, sort_order, id);
  `);
}

function normalizeArticleId(articleId) {
  const id = Number(articleId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('NOT_FOUND');
  return id;
}

function knowledgeImageUrl(articleId, imageId) {
  return `/bot-admin/api/knowledge/articles/${Number(articleId)}/images/${Number(imageId)}`;
}

function mapImage(row) {
  if (!row) return null;
  return {
    id: row.id,
    article_id: row.article_id,
    filename: row.filename,
    original_name: row.original_name || '',
    mime: row.mime,
    sort_order: row.sort_order ?? 0,
    url: knowledgeImageUrl(row.article_id, row.id),
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

function articleDir(articleId) {
  return path.join(getKnowledgeImagesRoot(), String(articleId));
}

function imageFilePath(row) {
  return path.join(articleDir(row.article_id), row.filename);
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function nextSortOrder(db, articleId) {
  const row = db
    .prepare(
      `SELECT MAX(sort_order) AS max_order
       FROM knowledge_article_images
       WHERE article_id = ?`
    )
    .get(articleId);
  if (row?.max_order == null) return 0;
  return Number(row.max_order) + 1;
}

function countKnowledgeImages(db, articleId) {
  ensureKnowledgeImageTables(db);
  const id = normalizeArticleId(articleId);
  return db
    .prepare('SELECT COUNT(*) AS count FROM knowledge_article_images WHERE article_id = ?')
    .get(id).count;
}

function listKnowledgeImages(db, articleId) {
  ensureKnowledgeImageTables(db);
  const id = normalizeArticleId(articleId);
  return db
    .prepare(
      `SELECT * FROM knowledge_article_images
       WHERE article_id = ?
       ORDER BY sort_order ASC, id ASC`
    )
    .all(id)
    .map(mapImage);
}

function listKnowledgeImagesForArticles(db, articleIds) {
  ensureKnowledgeImageTables(db);
  const ids = [
    ...new Set(
      (articleIds || [])
        .map((value) => Number(value))
        .filter((id) => Number.isFinite(id) && id > 0)
    ),
  ];
  const map = new Map();
  if (!ids.length) return map;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT * FROM knowledge_article_images
       WHERE article_id IN (${placeholders})
       ORDER BY sort_order ASC, id ASC`
    )
    .all(...ids);
  for (const row of rows) {
    const list = map.get(row.article_id) || [];
    list.push(mapImage(row));
    map.set(row.article_id, list);
  }
  return map;
}

function attachKnowledgeImages(db, items, idKey = 'id') {
  const list = Array.isArray(items) ? items : items ? [items] : [];
  const ids = list.map((item) => Number(item?.[idKey]));
  const map = listKnowledgeImagesForArticles(db, ids);
  for (const item of list) {
    if (!item) continue;
    item.images = map.get(Number(item[idKey])) || [];
  }
  return Array.isArray(items) ? list : list[0] || items;
}

function getKnowledgeImage(db, articleId, imageId) {
  ensureKnowledgeImageTables(db);
  const id = normalizeArticleId(articleId);
  const parsedImageId = Number(imageId);
  if (!Number.isFinite(parsedImageId) || parsedImageId <= 0) return null;
  const row = db
    .prepare(
      `SELECT * FROM knowledge_article_images
       WHERE id = ? AND article_id = ?`
    )
    .get(parsedImageId, id);
  return row || null;
}

function addKnowledgeImage(db, articleId, input = {}) {
  ensureKnowledgeImageTables(db);
  const id = normalizeArticleId(articleId);
  const buffer = input.buffer;
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('INVALID_IMAGE_TYPE');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('INVALID_IMAGE_SIZE');

  const sniffed = sniffImage(buffer);
  if (!sniffed) throw new Error('INVALID_IMAGE_TYPE');

  const existing = countKnowledgeImages(db, id);
  if (existing >= MAX_IMAGES_PER_ARTICLE) throw new Error('IMAGE_LIMIT_REACHED');

  const originalName = String(input.originalName || input.original_name || '')
    .trim()
    .slice(0, MAX_ORIGINAL_NAME);
  const sortOrder = nextSortOrder(db, id);
  const result = db
    .prepare(
      `INSERT INTO knowledge_article_images (
         article_id, filename, original_name, mime, sort_order, created_at
       ) VALUES (?, '', ?, ?, ?, datetime('now'))`
    )
    .run(id, originalName || null, sniffed.mime, sortOrder);
  const imageId = Number(result.lastInsertRowid);
  const filename = `${imageId}.${sniffed.ext}`;
  const dir = articleDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  try {
    fs.writeFileSync(filePath, buffer);
    db.prepare('UPDATE knowledge_article_images SET filename = ? WHERE id = ?').run(filename, imageId);
  } catch (error) {
    db.prepare('DELETE FROM knowledge_article_images WHERE id = ?').run(imageId);
    safeUnlink(filePath);
    throw error;
  }
  return mapImage(db.prepare('SELECT * FROM knowledge_article_images WHERE id = ?').get(imageId));
}

function escapeMarkdownAlt(value) {
  return String(value || '')
    .replace(/[\[\]]/g, '')
    .replace(/\r?\n/g, ' ')
    .trim()
    .slice(0, 120);
}

function appendKnowledgeImageMarkdown(body, image, alt) {
  const label = escapeMarkdownAlt(alt || image?.original_name || 'screenshot') || 'screenshot';
  const line = `![${label}](${image.url})`;
  const text = String(body || '').trimEnd();
  return text ? `${text}\n\n${line}` : line;
}

function knowledgeImageMarkdownPattern(image) {
  const url = image?.url || knowledgeImageUrl(image.article_id, image.id);
  const escaped = String(url).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`!?\\[[^\\]]*\\]\\(${escaped}\\)`, 'g');
}

function stripKnowledgeImageMarkdown(body, image) {
  const next = String(body || '')
    .replace(knowledgeImageMarkdownPattern(image), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return next;
}

function deleteKnowledgeImage(db, articleId, imageId) {
  const row = getKnowledgeImage(db, articleId, imageId);
  if (!row) throw new Error('NOT_FOUND');
  const mapped = mapImage(row);
  db.prepare('DELETE FROM knowledge_article_images WHERE id = ?').run(row.id);
  safeUnlink(imageFilePath(row));
  return mapped;
}

function deleteKnowledgeImagesForArticle(db, articleId) {
  ensureKnowledgeImageTables(db);
  const id = normalizeArticleId(articleId);
  const rows = db.prepare('SELECT * FROM knowledge_article_images WHERE article_id = ?').all(id);
  db.prepare('DELETE FROM knowledge_article_images WHERE article_id = ?').run(id);
  for (const row of rows) {
    safeUnlink(imageFilePath(row));
  }
  try {
    fs.rmdirSync(articleDir(id));
  } catch {
    // directory may be missing or not empty
  }
  return rows.length;
}

function resolveKnowledgeImageFile(row) {
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

function isBlockedIp(ip) {
  const value = String(ip || '').trim().toLowerCase();
  if (!value) return true;
  if (value.startsWith('::ffff:')) return isBlockedIp(value.slice(7));
  const version = net.isIP(value);
  if (version === 4) {
    const parts = value.split('.').map(Number);
    if (parts[0] === 0 || parts[0] === 10 || parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    return false;
  }
  if (version === 6) {
    if (value === '::1' || value === '::') return true;
    if (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80')) return true;
    return false;
  }
  return true;
}

function isBlockedHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === 'metadata.google.internal') return true;
  if (net.isIP(host) && isBlockedIp(host)) return true;
  return false;
}

function decodeKnowledgeImageData(data) {
  const raw = String(data || '').trim();
  if (!raw) throw new Error('INVALID_IMAGE_TYPE');
  const stripped = raw.replace(/^data:[^;]+;base64,/i, '');
  let buffer;
  try {
    buffer = Buffer.from(stripped, 'base64');
  } catch {
    throw new Error('INVALID_IMAGE_TYPE');
  }
  if (!buffer.length) throw new Error('INVALID_IMAGE_TYPE');
  return buffer;
}

function parseImageUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('INVALID_IMAGE_URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('INVALID_IMAGE_URL');
  if (url.username || url.password) throw new Error('INVALID_IMAGE_URL');
  if (isBlockedHostname(url.hostname)) throw new Error('INVALID_IMAGE_URL');
  return url;
}

async function resolvePublicAddress(url) {
  if (isBlockedHostname(url.hostname)) throw new Error('INVALID_IMAGE_URL');
  if (net.isIP(url.hostname)) {
    if (isBlockedIp(url.hostname)) throw new Error('INVALID_IMAGE_URL');
    return { address: url.hostname, family: net.isIP(url.hostname) };
  }
  let addresses;
  try {
    addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('INVALID_IMAGE_URL');
  }
  const publicAddr = (addresses || []).find((entry) => entry?.address && !isBlockedIp(entry.address));
  if (!publicAddr) throw new Error('INVALID_IMAGE_URL');
  return publicAddr;
}

function downloadToBuffer(url, address, remainingRedirects) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: address.address,
        family: address.family || undefined,
        servername: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          Host: url.host,
          Accept: 'image/*,*/*;q=0.8',
          'User-Agent': 'ScrapRegosKnowledge/1.0',
        },
        timeout: FETCH_TIMEOUT_MS,
      },
      (res) => {
        const status = Number(res.statusCode) || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (remainingRedirects <= 0) {
            reject(new Error('INVALID_IMAGE_URL'));
            return;
          }
          let next;
          try {
            next = new URL(res.headers.location, url);
          } catch {
            reject(new Error('INVALID_IMAGE_URL'));
            return;
          }
          fetchRemoteImageBuffer(next.href, remainingRedirects - 1).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error('INVALID_IMAGE_URL'));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_IMAGE_BYTES) {
            req.destroy();
            reject(new Error('INVALID_IMAGE_SIZE'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', () => reject(new Error('INVALID_IMAGE_URL')));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('INVALID_IMAGE_URL'));
    });
    req.on('error', () => reject(new Error('INVALID_IMAGE_URL')));
    req.end();
  });
}

async function fetchRemoteImageBuffer(urlString, remainingRedirects = FETCH_MAX_REDIRECTS) {
  const url = parseImageUrl(urlString);
  const address = await resolvePublicAddress(url);
  return downloadToBuffer(url, address, remainingRedirects);
}

module.exports = {
  MAX_IMAGES_PER_ARTICLE,
  MAX_IMAGE_BYTES,
  ensureKnowledgeImageTables,
  getKnowledgeImagesRoot,
  knowledgeImageUrl,
  countKnowledgeImages,
  listKnowledgeImages,
  attachKnowledgeImages,
  getKnowledgeImage,
  addKnowledgeImage,
  appendKnowledgeImageMarkdown,
  stripKnowledgeImageMarkdown,
  deleteKnowledgeImage,
  deleteKnowledgeImagesForArticle,
  resolveKnowledgeImageFile,
  isBlockedIp,
  decodeKnowledgeImageData,
  fetchRemoteImageBuffer,
};
