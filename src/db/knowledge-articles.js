const { mapSessionMessage, stringifyAttachments } = require('../ai/chat-uploads');

const MAX_TITLE = 200;
const MAX_BODY = 20000;
const MAX_TAGS = 300;
const MAX_CATEGORY_NAME = 100;
const ARTICLE_SELECT = `a.id, a.title, a.body, a.tags, a.locked, a.updated_by, a.created_at, a.updated_at,
       a.category_id, c.name AS category_name, c.tags AS category_tags`;
const ARTICLE_FROM = `knowledge_articles a LEFT JOIN knowledge_categories c ON c.id = a.category_id`;

/** Tokens ignored during knowledge search (ru / uz / en). */
const SEARCH_STOPWORDS = new Set([
  'и',
  'в',
  'на',
  'по',
  'с',
  'к',
  'о',
  'у',
  'из',
  'за',
  'от',
  'для',
  'или',
  'как',
  'что',
  'это',
  'the',
  'a',
  'an',
  'of',
  'to',
  'in',
  'on',
  'for',
  'or',
  'and',
  'is',
  'at',
  'da',
  'ham',
  'bilan',
  'uchun',
  'qayerda',
  'qayer',
  'joylashgan',
  'bormi',
]);

/** Synonym groups so uz/en queries hit Russian KB wording. */
const SEARCH_SYNONYM_GROUPS = [
  ['офис', 'офисы', 'ofis', 'ofisingiz', 'адрес', 'адреса', 'manzil', 'филиал', 'location', 'contact', 'контакты', 'контакт'],
  ['прайс', 'цена', 'цены', 'стоимость', 'narx', 'price', 'prices'],
  ['менеджер', 'продажи', 'sales', 'эскалация'],
  ['заказ', 'заказы', 'оплата', 'техподдержка', 'поддержка', 'support'],
  ['телефон', 'phone', 'telegram', 'instagram'],
  ['ташкент', 'toshkent', 'самарканд', 'samarqand', 'samarkand'],
];

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

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col) => col.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function ensureKnowledgeFts(db) {
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
  } catch (error) {
    if (!ensureKnowledgeFts.warned) {
      ensureKnowledgeFts.warned = true;
      console.warn('[knowledge] FTS5 unavailable, falling back to LIKE search:', error.message);
    }
  }
}

function foldSearchText(value) {
  return String(value || '').toLocaleLowerCase('ru-RU');
}

function tokenizeKnowledgeQuery(query) {
  const parts = String(query || '')
    .split(/[^\p{L}\p{N}_]+/u)
    .map((part) => foldSearchText(part))
    .filter((part) => part.length >= 3 && !SEARCH_STOPWORDS.has(part));
  return [...new Set(parts)];
}

function synonymVariantsForToken(token) {
  const folded = foldSearchText(token);
  const variants = new Set([folded]);
  for (const group of SEARCH_SYNONYM_GROUPS) {
    const hit = group.some((member) => {
      const m = foldSearchText(member);
      return m === folded || (m.length >= 3 && (folded.startsWith(m) || m.startsWith(folded)));
    });
    if (hit) {
      for (const member of group) variants.add(foldSearchText(member));
    }
  }
  return [...variants];
}

function expandKnowledgeSearchTokens(tokens) {
  const out = new Set();
  for (const token of tokens) {
    for (const variant of synonymVariantsForToken(token)) out.add(variant);
  }
  return [...out];
}

function escapeFtsToken(token) {
  return String(token || '').replace(/"/g, '""');
}

function buildFtsOrQuery(tokens) {
  return tokens
    .map((token) => {
      const escaped = escapeFtsToken(token);
      if (!escaped) return null;
      return `"${escaped}"*`;
    })
    .filter(Boolean)
    .join(' OR ');
}

function scoreArticleAgainstTokens(article, queryTokens) {
  const title = foldSearchText(article.title);
  const body = foldSearchText(article.body);
  const tags = foldSearchText(article.tags);
  let score = 0;
  let hits = 0;
  for (const token of queryTokens) {
    const literal = foldSearchText(token);
    const variants = synonymVariantsForToken(token);
    let best = 0;
    for (const variant of variants) {
      if (!variant) continue;
      const boost = variant === literal ? 2 : 0;
      if (title.includes(variant)) best = Math.max(best, 8 + boost);
      else if (tags.includes(variant)) best = Math.max(best, 5 + boost);
      else if (body.includes(variant)) best = Math.max(best, 2 + boost);
    }
    if (best > 0) {
      hits += 1;
      score += best;
    }
  }
  if (!hits) return 0;
  return score + hits * 10;
}

function compareScoredArticles(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const byDate = String(b.article.updated_at || '').localeCompare(String(a.article.updated_at || ''));
  if (byDate) return byDate;
  return Number(b.article.id) - Number(a.article.id);
}

function pageScoredArticles(scored, { limit, offset }) {
  scored.sort(compareScoredArticles);
  return {
    articles: scored.slice(offset, offset + limit).map((row) => row.article),
    total: scored.length,
  };
}

function categoryFilterClause(categoryId) {
  if (categoryId === undefined) return { sql: '', params: [] };
  if (categoryId === null) return { sql: ' AND a.category_id IS NULL', params: [] };
  return { sql: ' AND a.category_id = ?', params: [Number(categoryId)] };
}

function searchArticlesByTokens(db, { queryTokens, limit, offset, categoryId }) {
  if (!queryTokens.length) return { articles: [], total: 0 };
  const filter = categoryFilterClause(categoryId);
  const rows = db
    .prepare(`SELECT ${ARTICLE_SELECT} FROM ${ARTICLE_FROM} WHERE 1=1${filter.sql}`)
    .all(...filter.params)
    .map(mapArticle);
  const scored = [];
  for (const article of rows) {
    const score = scoreArticleAgainstTokens(article, queryTokens);
    if (score > 0) scored.push({ article, score });
  }
  return pageScoredArticles(scored, { limit, offset });
}

function seedKnowledgeArticles(db) {
  const count = db.prepare('SELECT COUNT(*) AS count FROM knowledge_articles').get().count;
  if (count > 0) return;
  const insert = db.prepare(
    `INSERT INTO knowledge_articles (title, body, tags, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`
  );
  for (const article of SEED_ARTICLES) {
    insert.run(article.title, article.body, article.tags);
  }
}

function ensureKnowledgeTables(db) {
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
  ensureKnowledgeFts(db);
  seedKnowledgeArticles(db);
}

function mapCategory(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    tags: row.tags || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeCategoryInput(input = {}) {
  const name = String(input.name || '').trim();
  const tags = String(input.tags || '').trim();
  if (!name || name.length > MAX_CATEGORY_NAME) throw new Error('INVALID_CATEGORY_NAME');
  if (tags.length > MAX_TAGS) throw new Error('INVALID_CATEGORY_TAGS');
  return { name, tags: tags || null };
}

function listKnowledgeCategories(db) {
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

function formatKnowledgeCategoriesForTools(db) {
  const categories = db ? listKnowledgeCategories(db) : [];
  if (!categories.length) return 'No categories yet. Omit category_id.';
  const list = categories.map((category) => `${category.id} ${category.name}`).join('; ');
  return `Categories: ${list}. Omit or null for none.`;
}

function knowledgeCategoryContext(db) {
  return formatKnowledgeCategoriesForTools(db);
}

function getKnowledgeCategory(db, id) {
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

function createKnowledgeCategory(db, input) {
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

function updateKnowledgeCategory(db, id, input = {}) {
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

function deleteKnowledgeCategory(db, id) {
  const current = getKnowledgeCategory(db, id);
  if (!current) return false;
  db.prepare('UPDATE knowledge_articles SET category_id = NULL WHERE category_id = ?').run(current.id);
  db.prepare('DELETE FROM knowledge_categories WHERE id = ?').run(current.id);
  return true;
}

function normalizeArticleCategoryId(db, value) {
  if (value === undefined) return undefined;
  if (value === null || value === '' || value === 0 || value === '0') return null;
  const categoryId = Number(value);
  if (!Number.isFinite(categoryId) || categoryId <= 0) throw new Error('INVALID_ARTICLE_CATEGORY');
  const category = getKnowledgeCategory(db, categoryId);
  if (!category) throw new Error('INVALID_ARTICLE_CATEGORY');
  return category.id;
}

function normalizeArticleInput(input = {}) {
  const title = String(input.title || '').trim();
  const body = String(input.body || '').trim();
  const tags = String(input.tags || '').trim();
  if (!title || title.length > MAX_TITLE) throw new Error('INVALID_ARTICLE_TITLE');
  if (!body || body.length > MAX_BODY) throw new Error('INVALID_ARTICLE_BODY');
  if (tags.length > MAX_TAGS) throw new Error('INVALID_ARTICLE_TAGS');
  return { title, body, tags: tags || null };
}

function mapArticle(row) {
  if (!row) return null;
  const categoryId = row.category_id ?? null;
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    tags: row.tags || '',
    category_id: categoryId,
    category: categoryId
      ? {
          id: categoryId,
          name: row.category_name || '',
          tags: row.category_tags || '',
        }
      : null,
    locked: Boolean(row.locked),
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function assertArticleWritable(article) {
  if (article?.locked) throw new Error('ARTICLE_LOCKED');
}

function listKnowledgeArticles(db, { query, limit = 100, offset = 0, categoryId } = {}) {
  ensureKnowledgeTables(db);
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const filter = categoryFilterClause(categoryId);
  const trimmed = String(query || '').trim();
  if (!trimmed) {
    const total = db
      .prepare(`SELECT COUNT(*) AS count FROM knowledge_articles a WHERE 1=1${filter.sql}`)
      .get(...filter.params).count;
    const articles = db
      .prepare(
        `SELECT ${ARTICLE_SELECT}
         FROM ${ARTICLE_FROM}
         WHERE 1=1${filter.sql}
         ORDER BY datetime(a.updated_at) DESC, a.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...filter.params, safeLimit, safeOffset)
      .map(mapArticle);
    return { articles, total };
  }

  const queryTokens = tokenizeKnowledgeQuery(trimmed);
  const matchTokens = expandKnowledgeSearchTokens(queryTokens);
  if (!matchTokens.length) return { articles: [], total: 0 };

  if (tableExists(db, 'knowledge_articles_fts')) {
    try {
      const ftsQuery = buildFtsOrQuery(matchTokens);
      if (ftsQuery) {
        const rows = db
          .prepare(
            `SELECT ${ARTICLE_SELECT}
             FROM knowledge_articles_fts f
             JOIN knowledge_articles a ON a.id = f.rowid
             LEFT JOIN knowledge_categories c ON c.id = a.category_id
             WHERE knowledge_articles_fts MATCH ?${filter.sql}
             LIMIT ?`
          )
          .all(ftsQuery, ...filter.params, 200);
        if (rows.length > 0) {
          const scoreTokens = queryTokens.length ? queryTokens : matchTokens;
          const scored = rows.map((row) => {
            const article = mapArticle(row);
            return { article, score: scoreArticleAgainstTokens(article, scoreTokens) };
          });
          return pageScoredArticles(scored, { limit: safeLimit, offset: safeOffset });
        }
      }
      // Empty FTS hit — fall through to tokenized scoring (never return empty solely on FTS AND/OR miss).
    } catch {
      // Invalid FTS query — fall through.
    }
  }

  return searchArticlesByTokens(db, {
    queryTokens: queryTokens.length ? queryTokens : matchTokens,
    limit: safeLimit,
    offset: safeOffset,
    categoryId,
  });
}

function getKnowledgeArticle(db, id) {
  ensureKnowledgeTables(db);
  const articleId = Number(id);
  if (!Number.isFinite(articleId) || articleId <= 0) return null;
  return mapArticle(
    db
      .prepare(
        `SELECT ${ARTICLE_SELECT}
         FROM ${ARTICLE_FROM}
         WHERE a.id = ?`
      )
      .get(articleId)
  );
}

function createKnowledgeArticle(db, input, { updatedBy } = {}) {
  ensureKnowledgeTables(db);
  const article = normalizeArticleInput(input);
  const categoryId = normalizeArticleCategoryId(db, input.category_id) ?? null;
  const result = db
    .prepare(
      `INSERT INTO knowledge_articles (title, body, tags, category_id, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .run(article.title, article.body, article.tags, categoryId, updatedBy ?? null);
  return getKnowledgeArticle(db, Number(result.lastInsertRowid));
}

function updateKnowledgeArticle(db, id, input, { updatedBy } = {}) {
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

function deleteKnowledgeArticle(db, id) {
  const current = getKnowledgeArticle(db, id);
  if (!current) return false;
  assertArticleWritable(current);
  db.prepare('DELETE FROM knowledge_articles WHERE id = ?').run(current.id);
  return true;
}

function setKnowledgeArticleLocked(db, id, locked, { updatedBy } = {}) {
  const current = getKnowledgeArticle(db, id);
  if (!current) throw new Error('NOT_FOUND');
  db.prepare(
    `UPDATE knowledge_articles
     SET locked = ?, updated_by = COALESCE(?, updated_by), updated_at = datetime('now')
     WHERE id = ?`
  ).run(locked ? 1 : 0, updatedBy ?? null, current.id);
  return getKnowledgeArticle(db, current.id);
}

function getOrCreateKbSession(db, { sessionId, userId, reset = false } = {}) {
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

function listKbSessionMessages(db, sessionId, { limit = 50 } = {}) {
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

function addKbSessionMessage(db, sessionId, { role, content, attachments } = {}) {
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

function sessionBelongsToUser(session, userId) {
  if (userId == null || session?.user_id == null) return true;
  return Number(session.user_id) === Number(userId);
}

function clearKbSessionHistory(db, { sessionId, userId } = {}) {
  ensureKnowledgeTables(db);
  const session = getOrCreateKbSession(db, { sessionId, userId });
  if (!sessionBelongsToUser(session, userId)) {
    throw new Error('FORBIDDEN');
  }
  db.prepare('DELETE FROM ai_kb_messages WHERE session_id = ?').run(session.id);
  db.prepare(`UPDATE ai_kb_sessions SET updated_at = datetime('now') WHERE id = ?`).run(session.id);
  return session;
}

module.exports = {
  MAX_TITLE,
  MAX_BODY,
  MAX_CATEGORY_NAME,
  SEED_ARTICLES,
  ensureKnowledgeTables,
  tokenizeKnowledgeQuery,
  listKnowledgeCategories,
  formatKnowledgeCategoriesForTools,
  knowledgeCategoryContext,
  getKnowledgeCategory,
  createKnowledgeCategory,
  updateKnowledgeCategory,
  deleteKnowledgeCategory,
  listKnowledgeArticles,
  getKnowledgeArticle,
  createKnowledgeArticle,
  updateKnowledgeArticle,
  deleteKnowledgeArticle,
  setKnowledgeArticleLocked,
  getOrCreateKbSession,
  listKbSessionMessages,
  addKbSessionMessage,
  clearKbSessionHistory,
};
