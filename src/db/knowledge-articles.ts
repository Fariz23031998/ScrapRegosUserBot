import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { mapSessionMessage, stringifyAttachments } from '../ai/chat-uploads';
import { attachKnowledgeImages, deleteKnowledgeImagesForArticle, ensureKnowledgeImageTables, appendKnowledgeImageMarkdown, stripKnowledgeImageMarkdown } from './knowledge-images';
import { ARTICLE_SELECT, ARTICLE_FROM, mapArticle } from './knowledge-search';

const MAX_TITLE = 200;
const MAX_BODY = 20000;
const MAX_TAGS = 300;
const MAX_CATEGORY_NAME = 100;

const SEED_ARTICLES = [
  {
    title: 'Прайс и стоимость услуг',
    body: 'Цены на услуги компании хранятся в каталоге прайса и в тарифах технической поддержки. Для ответа клиенту сначала найдите актуальные цены инструментом get_prices. Не называйте цены, которых нет в каталоге.',
    tags: 'прайс, цены, услуги',
  },
  {
    title: 'Передача менеджеру по продажам',
    body: 'Если клиент просит менеджера по продажам, коммерческое предложение или хочет обсудить тариф/договор, найдите сотрудника через get_employee (должность «менеджер по продажам»), кратко перескажите запрос и вызовите notify_employee. При наличии regos_user_id можно назначить его ответственным через assign_responsible. Срочные поломки, KKM, новых клиентов и выезды можно продублировать во внутреннюю группу через list_group_topics и send_group_topic_message.',
    tags: 'менеджер, продажи, эскалация',
  },
  {
    title: 'Заказы и техническая поддержка',
    body: 'Неоплаченные заказы и подписки техподдержки ищите по телефону клиента (search_orders). Если клиент спрашивает статус оплаты или срок поддержки, опирайтесь на найденные заказы, а не на догадки.',
    tags: 'заказы, оплата, техподдержка',
  },
];

function tableExists(db: Db, name?: any) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

function ensureColumn(db: Db, table?: any, column?: any, ddl?: any) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col?: any) => col.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function ensureKnowledgeFts(db: Db) {
  if (tableExists(db, 'knowledge_articles_fts')) return;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE knowledge_articles_fts USING fts5(
        title, body, tags, content='knowledge_articles', content_rowid='id'
      );
      CREATE TRIGGER knowledge_articles_ai AFTER INSERT ON knowledge_articles BEGIN
        INSERT INTO knowledge_articles_fts(rowid, title, body, tags)
        VALUES (new.id, new.title, new.body, COALESCE(new.tags, ''));
      END;
      CREATE TRIGGER knowledge_articles_ad AFTER DELETE ON knowledge_articles BEGIN
        INSERT INTO knowledge_articles_fts(knowledge_articles_fts, rowid, title, body, tags)
        VALUES ('delete', old.id, old.title, old.body, COALESCE(old.tags, ''));
      END;
      CREATE TRIGGER knowledge_articles_au AFTER UPDATE ON knowledge_articles BEGIN
        INSERT INTO knowledge_articles_fts(knowledge_articles_fts, rowid, title, body, tags)
        VALUES ('delete', old.id, old.title, old.body, COALESCE(old.tags, ''));
        INSERT INTO knowledge_articles_fts(rowid, title, body, tags)
        VALUES (new.id, new.title, new.body, COALESCE(new.tags, ''));
      END;
    `);
    db.exec(`INSERT INTO knowledge_articles_fts(knowledge_articles_fts) VALUES('rebuild')`);
  } catch (error: any) {
    const fts = ensureKnowledgeFts as typeof ensureKnowledgeFts & { warned?: boolean };
    if (!fts.warned) {
      fts.warned = true;
      console.warn('[knowledge] FTS5 unavailable, falling back to LIKE search:', error.message);
    }
  }
}

function normalizeKnowledgeCreator({ creator, updatedBy }: Unchecked = {}) {
  if (creator != null) {
    const text = String(creator).trim();
    if (text) return text;
  }
  if (updatedBy != null && updatedBy !== '') return String(updatedBy);
  return null;
}


function seedKnowledgeArticles(db: Db) {
  const count = (db.prepare('SELECT COUNT(*) AS count FROM knowledge_articles').get() as { count: number } | undefined)!.count;
  if (count > 0) return;
  const insert = db.prepare(
    `INSERT INTO knowledge_articles (title, body, tags, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`
  );
  for (const article of SEED_ARTICLES) {
    insert.run(article.title, article.body, article.tags);
  }
}

function ensureKnowledgeTables(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      tags TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS knowledge_articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      tags TEXT,
      updated_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_kb_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_kb_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES ai_kb_sessions(id) ON DELETE CASCADE
    );
  `);
  ensureColumn(db, 'ai_kb_messages', 'attachments', 'TEXT');
  ensureColumn(db, 'knowledge_articles', 'locked', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'knowledge_articles', 'category_id', 'INTEGER');
  ensureColumn(db, 'knowledge_articles', 'is_confirmed', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'knowledge_articles', 'creator', 'TEXT');
  ensureKnowledgeImageTables(db);
  ensureKnowledgeFts(db);
  seedKnowledgeArticles(db);
}

function mapCategory(row?: any) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    tags: row.tags || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeCategoryInput(input: any = {}) {
  const name = String(input.name || '').trim();
  const tags = String(input.tags || '').trim();
  if (!name || name.length > MAX_CATEGORY_NAME) throw new Error('INVALID_CATEGORY_NAME');
  if (tags.length > MAX_TAGS) throw new Error('INVALID_CATEGORY_TAGS');
  return { name, tags: tags || null };
}

function listKnowledgeCategories(db: Db) {
  ensureKnowledgeTables(db);
  return db
    .prepare(
      `SELECT id, name, tags, created_at, updated_at
       FROM knowledge_categories
       ORDER BY name COLLATE NOCASE ASC, id ASC`
    )
    .all()
    .map(mapCategory);
}

function formatKnowledgeCategoriesForTools(db: Db) {
  const categories = db ? listKnowledgeCategories(db) : [];
  if (!categories.length) return 'No categories yet. Omit category_id.';
  const list = categories.map((category?: any) => `${category.id} ${category.name}`).join('; ');
  return `Categories: ${list}. Omit or null for none.`;
}

function knowledgeCategoryContext(db: Db) {
  return formatKnowledgeCategoriesForTools(db);
}

function getKnowledgeCategory(db: Db, id?: any) {
  ensureKnowledgeTables(db);
  const categoryId = Number(id);
  if (!Number.isFinite(categoryId) || categoryId <= 0) return null;
  return mapCategory(
    db
      .prepare(
        `SELECT id, name, tags, created_at, updated_at
         FROM knowledge_categories WHERE id = ?`
      )
      .get(categoryId)
  );
}

function createKnowledgeCategory(db: Db, input?: any) {
  ensureKnowledgeTables(db);
  const category = normalizeCategoryInput(input);
  const result = db
    .prepare(
      `INSERT INTO knowledge_categories (name, tags, created_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))`
    )
    .run(category.name, category.tags);
  return getKnowledgeCategory(db, Number(result.lastInsertRowid));
}

function updateKnowledgeCategory(db: Db, id: any, input: any = {}) {
  const current = getKnowledgeCategory(db, id);
  if (!current) throw new Error('NOT_FOUND');
  const category = normalizeCategoryInput({
    name: input.name != null ? input.name : current.name,
    tags: input.tags != null ? input.tags : current.tags,
  });
  db.prepare(
    `UPDATE knowledge_categories
     SET name = ?, tags = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(category.name, category.tags, current.id);
  return getKnowledgeCategory(db, current.id);
}

function deleteKnowledgeCategory(db: Db, id?: any) {
  const current = getKnowledgeCategory(db, id);
  if (!current) return false;
  db.prepare('UPDATE knowledge_articles SET category_id = NULL WHERE category_id = ?').run(current.id);
  db.prepare('DELETE FROM knowledge_categories WHERE id = ?').run(current.id);
  return true;
}

function normalizeArticleCategoryId(db: Db, value?: any) {
  if (value === undefined) return undefined;
  if (value === null || value === '' || value === 0 || value === '0') return null;
  const categoryId = Number(value);
  if (!Number.isFinite(categoryId) || categoryId <= 0) throw new Error('INVALID_ARTICLE_CATEGORY');
  const category = getKnowledgeCategory(db, categoryId);
  if (!category) throw new Error('INVALID_ARTICLE_CATEGORY');
  return category.id;
}

function normalizeArticleInput(input: any = {}) {
  const title = String(input.title || '').trim();
  const body = String(input.body || '').trim();
  const tags = String(input.tags || '').trim();
  if (!title || title.length > MAX_TITLE) throw new Error('INVALID_ARTICLE_TITLE');
  if (!body || body.length > MAX_BODY) throw new Error('INVALID_ARTICLE_BODY');
  if (tags.length > MAX_TAGS) throw new Error('INVALID_ARTICLE_TAGS');
  return { title, body, tags: tags || null };
}



function assertArticleWritable(article?: any) {
  if (article?.locked) throw new Error('ARTICLE_LOCKED');
}



function getKnowledgeArticle(db: Db, id: any, { confirmedOnly = false }: Unchecked = {}) {
  ensureKnowledgeTables(db);
  const articleId = Number(id);
  if (!Number.isFinite(articleId) || articleId <= 0) return null;
  const article = mapArticle(
    db
      .prepare(
        `SELECT ${ARTICLE_SELECT}
         FROM ${ARTICLE_FROM}
         WHERE a.id = ?`
      )
      .get(articleId)
  );
  if (!article) return null;
  if (confirmedOnly && !article.is_confirmed) return null;
  attachKnowledgeImages(db, article);
  return article;
}

function createKnowledgeArticle(db: Db, input: any, { updatedBy, creator }: Unchecked = {}) {
  ensureKnowledgeTables(db);
  const article = normalizeArticleInput(input);
  const categoryId = normalizeArticleCategoryId(db, input.category_id) ?? null;
  const resolvedCreator = normalizeKnowledgeCreator({ creator, updatedBy });
  const result = db
    .prepare(
      `INSERT INTO knowledge_articles (title, body, tags, category_id, updated_by, creator, is_confirmed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`
    )
    .run(article.title, article.body, article.tags, categoryId, updatedBy ?? null, resolvedCreator);
  return getKnowledgeArticle(db, Number(result.lastInsertRowid));
}

function updateKnowledgeArticle(db: Db, id: any, input: any, { updatedBy }: Unchecked = {}) {
  const current = getKnowledgeArticle(db, id);
  if (!current) throw new Error('NOT_FOUND');
  assertArticleWritable(current);
  const article = normalizeArticleInput({
    title: input.title != null ? input.title : current.title,
    body: input.body != null ? input.body : current.body,
    tags: input.tags != null ? input.tags : current.tags,
  });
  const nextCategoryId = normalizeArticleCategoryId(db, input.category_id);
  const categoryId = nextCategoryId === undefined ? current.category_id : nextCategoryId;
  db.prepare(
    `UPDATE knowledge_articles
     SET title = ?, body = ?, tags = ?, category_id = ?, updated_by = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    article.title,
    article.body,
    article.tags,
    categoryId,
    updatedBy ?? current.updated_by,
    current.id
  );
  return getKnowledgeArticle(db, current.id);
}

function deleteKnowledgeArticle(db: Db, id?: any) {
  const current = getKnowledgeArticle(db, id);
  if (!current) return false;
  assertArticleWritable(current);
  deleteKnowledgeImagesForArticle(db, current.id);
  db.prepare('DELETE FROM knowledge_articles WHERE id = ?').run(current.id);
  return true;
}

function appendKnowledgeArticleImage(db: Db, article: any, image: any, alt: any, { updatedBy }: Unchecked = {}) {
  const nextBody = appendKnowledgeImageMarkdown(article.body, image, alt);
  if (nextBody === article.body || nextBody.length > MAX_BODY) {
    return getKnowledgeArticle(db, article.id);
  }
  db.prepare(
    `UPDATE knowledge_articles
     SET body = ?, updated_by = COALESCE(?, updated_by), updated_at = datetime('now')
     WHERE id = ?`
  ).run(nextBody, updatedBy ?? null, article.id);
  return getKnowledgeArticle(db, article.id);
}

function stripKnowledgeArticleImage(db: Db, article: any, image: any, { updatedBy }: Unchecked = {}) {
  const nextBody = stripKnowledgeImageMarkdown(article.body, image);
  if (nextBody === String(article.body || '').trim()) {
    return getKnowledgeArticle(db, article.id);
  }
  db.prepare(
    `UPDATE knowledge_articles
     SET body = ?, updated_by = COALESCE(?, updated_by), updated_at = datetime('now')
     WHERE id = ?`
  ).run(nextBody || article.title, updatedBy ?? null, article.id);
  return getKnowledgeArticle(db, article.id);
}

function setKnowledgeArticleLocked(db: Db, id: any, locked: any, { updatedBy }: Unchecked = {}) {
  const current = getKnowledgeArticle(db, id);
  if (!current) throw new Error('NOT_FOUND');
  db.prepare(
    `UPDATE knowledge_articles
     SET locked = ?, updated_by = COALESCE(?, updated_by), updated_at = datetime('now')
     WHERE id = ?`
  ).run(locked ? 1 : 0, updatedBy ?? null, current.id);
  return getKnowledgeArticle(db, current.id);
}

function setKnowledgeArticleConfirmed(db: Db, id: any, confirmed: any, { updatedBy }: Unchecked = {}) {
  const current = getKnowledgeArticle(db, id);
  if (!current) throw new Error('NOT_FOUND');
  db.prepare(
    `UPDATE knowledge_articles
     SET is_confirmed = ?, updated_by = COALESCE(?, updated_by), updated_at = datetime('now')
     WHERE id = ?`
  ).run(confirmed ? 1 : 0, updatedBy ?? null, current.id);
  return getKnowledgeArticle(db, current.id);
}

function getOrCreateKbSession(db: Db, { sessionId, userId, reset = false }: Unchecked = {}) {
  ensureKnowledgeTables(db);
  if (!reset && sessionId) {
    const existing = db.prepare('SELECT * FROM ai_kb_sessions WHERE id = ?').get(Number(sessionId));
    if (existing) return existing;
  }
  if (!reset && userId != null) {
    const latest = db
      .prepare(
        `SELECT * FROM ai_kb_sessions
         WHERE user_id = ?
         ORDER BY datetime(updated_at) DESC, id DESC
         LIMIT 1`
      )
      .get(Number(userId));
    if (latest) return latest;
  }
  const result = db
    .prepare(
      `INSERT INTO ai_kb_sessions (user_id, created_at, updated_at)
       VALUES (?, datetime('now'), datetime('now'))`
    )
    .run(userId ?? null);
  return db.prepare('SELECT * FROM ai_kb_sessions WHERE id = ?').get(Number(result.lastInsertRowid));
}

function listKbSessionMessages(db: Db, sessionId: any, { limit = 50 }: Unchecked = {}) {
  ensureKnowledgeTables(db);
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  return db
    .prepare(
      `SELECT id, session_id, role, content, attachments, created_at
       FROM ai_kb_messages
       WHERE session_id = ?
       ORDER BY id ASC
       LIMIT ?`
    )
    .all(Number(sessionId), safeLimit)
    .map(mapSessionMessage);
}

function addKbSessionMessage(db: Db, sessionId: any, { role, content, attachments }: Unchecked = {}) {
  ensureKnowledgeTables(db);
  const normalizedRole = role === 'assistant' ? 'assistant' : 'user';
  const text = String(content || '').trim();
  const stored = stringifyAttachments(attachments);
  if (!text && !stored) throw new Error('EMPTY_MESSAGE');
  db.prepare(
    `INSERT INTO ai_kb_messages (session_id, role, content, attachments, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(Number(sessionId), normalizedRole, text, stored);
  db.prepare(`UPDATE ai_kb_sessions SET updated_at = datetime('now') WHERE id = ?`).run(Number(sessionId));
  return listKbSessionMessages(db, sessionId);
}

function sessionBelongsToUser(session?: any, userId?: any) {
  if (userId == null || session?.user_id == null) return true;
  return Number(session.user_id) === Number(userId);
}

function clearKbSessionHistory(db: Db, { sessionId, userId }: Unchecked = {}) {
  ensureKnowledgeTables(db);
  const session = getOrCreateKbSession(db, { sessionId, userId });
  if (!sessionBelongsToUser(session, userId)) {
    throw new Error('FORBIDDEN');
  }
  db.prepare('DELETE FROM ai_kb_messages WHERE session_id = ?').run(session!.id);
  db.prepare(`UPDATE ai_kb_sessions SET updated_at = datetime('now') WHERE id = ?`).run(session!.id);
  return session;
}

export {
  MAX_TITLE,
  MAX_BODY,
  MAX_CATEGORY_NAME,
  SEED_ARTICLES,
  ensureKnowledgeTables,
  listKnowledgeCategories,
  formatKnowledgeCategoriesForTools,
  knowledgeCategoryContext,
  getKnowledgeCategory,
  createKnowledgeCategory,
  updateKnowledgeCategory,
  deleteKnowledgeCategory,
  getKnowledgeArticle,
  createKnowledgeArticle,
  updateKnowledgeArticle,
  deleteKnowledgeArticle,
  appendKnowledgeArticleImage,
  stripKnowledgeArticleImage,
  setKnowledgeArticleLocked,
  setKnowledgeArticleConfirmed,
  getOrCreateKbSession,
  listKbSessionMessages,
  addKbSessionMessage,
  clearKbSessionHistory,
};
export { tokenizeKnowledgeQuery, listKnowledgeArticles } from './knowledge-search';
