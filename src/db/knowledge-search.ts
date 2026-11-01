import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { attachKnowledgeImages } from './knowledge-images';
import { ensureKnowledgeTables } from './knowledge-articles';

const ARTICLE_SELECT = `a.id, a.title, a.body, a.tags, a.locked, a.is_confirmed, a.creator, a.updated_by, a.created_at, a.updated_at,
       a.category_id, c.name AS category_name, c.tags AS category_tags`;
const ARTICLE_FROM = `knowledge_articles a LEFT JOIN knowledge_categories c ON c.id = a.category_id`;

function tableExists(db: Db, name?: any) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

/** Tokens ignored during knowledge search (ru / uz / en). */
const SEARCH_STOPWORDS: Set<any> = new Set([
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

function foldSearchText(value?: any) {
  return String(value || '').toLocaleLowerCase('ru-RU');
}

function tokenizeKnowledgeQuery(query?: any) {
  const parts = String(query || '')
    .split(/[^\p{L}\p{N}_]+/u)
    .map((part?: any) => foldSearchText(part))
    .filter((part?: any) => part.length >= 3 && !SEARCH_STOPWORDS.has(part));
  return [...new Set(parts)];
}

function synonymVariantsForToken(token?: any) {
  const folded = foldSearchText(token);
  const variants: Set<any> = new Set([folded]);
  for (const group of SEARCH_SYNONYM_GROUPS) {
    const hit = group.some((member?: any) => {
      const m = foldSearchText(member);
      return m === folded || (m.length >= 3 && (folded.startsWith(m) || m.startsWith(folded)));
    });
    if (hit) {
      for (const member of group) variants.add(foldSearchText(member));
    }
  }
  return [...variants];
}

function expandKnowledgeSearchTokens(tokens?: any) {
  const out: Set<any> = new Set();
  for (const token of tokens) {
    for (const variant of synonymVariantsForToken(token)) out.add(variant);
  }
  return [...out];
}

function escapeFtsToken(token?: any) {
  return String(token || '').replace(/"/g, '""');
}

function buildFtsOrQuery(tokens?: any) {
  return tokens
    .map((token?: any) => {
      const escaped = escapeFtsToken(token);
      if (!escaped) return null;
      return `"${escaped}"*`;
    })
    .filter(Boolean)
    .join(' OR ');
}

function scoreArticleAgainstTokens(article?: any, queryTokens?: any) {
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

function compareScoredArticles(a?: any, b?: any) {
  if (b.score !== a.score) return b.score - a.score;
  const byDate = String(b.article.updated_at || '').localeCompare(String(a.article.updated_at || ''));
  if (byDate) return byDate;
  return Number(b.article.id) - Number(a.article.id);
}

function pageScoredArticles(scored: any, { limit, offset }: Unchecked) {
  scored.sort(compareScoredArticles);
  return {
    articles: scored.slice(offset, offset + limit).map((row?: any) => row.article),
    total: scored.length,
  };
}

function categoryFilterClause(categoryId?: any) {
  if (categoryId === undefined) return { sql: '', params: [] };
  if (categoryId === null) return { sql: ' AND a.category_id IS NULL', params: [] };
  return { sql: ' AND a.category_id = ?', params: [Number(categoryId)] };
}

function articleListFilter({ categoryId, confirmedOnly }: Unchecked = {}) {
  const category = categoryFilterClause(categoryId);
  if (!confirmedOnly) return category;
  return {
    sql: `${category.sql} AND a.is_confirmed = 1`,
    params: category.params,
  };
}

function searchArticlesByTokens(db: Db, { queryTokens, limit, offset, categoryId, confirmedOnly }: Unchecked = {}) {
  if (!queryTokens.length) return { articles: [], total: 0 };
  const filter = articleListFilter({ categoryId, confirmedOnly });
  const rows = db
    .prepare(`SELECT ${ARTICLE_SELECT} FROM ${ARTICLE_FROM} WHERE 1=1${filter.sql}`)
    .all(...filter.params)
    .map(mapArticle);
  const scored: any[] = [];
  for (const article of rows) {
    const score = scoreArticleAgainstTokens(article, queryTokens);
    if (score > 0) scored.push({ article, score });
  }
  return pageScoredArticles(scored, { limit, offset });
}

function mapArticle(row?: any) {
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
    is_confirmed: Boolean(row.is_confirmed),
    creator: row.creator ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listKnowledgeArticles(db: Db, { query, limit = 100, offset = 0, categoryId, confirmedOnly = false }: Unchecked = {}) {
  ensureKnowledgeTables(db);
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const filter = articleListFilter({ categoryId, confirmedOnly });
  const trimmed = String(query || '').trim();
  if (!trimmed) {
    const total = (
      db
        .prepare(`SELECT COUNT(*) AS count FROM knowledge_articles a WHERE 1=1${filter.sql}`)
        .get(...filter.params) as { count: number } | undefined
    )!.count;
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
    attachKnowledgeImages(db, articles);
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
          const scored = rows.map((row?: any) => {
            const article = mapArticle(row);
            return { article, score: scoreArticleAgainstTokens(article, scoreTokens) };
          });
          const paged = pageScoredArticles(scored, { limit: safeLimit, offset: safeOffset });
          attachKnowledgeImages(db, paged.articles);
          return paged;
        }
      }
      // Empty FTS hit — fall through to tokenized scoring (never return empty solely on FTS AND/OR miss).
    } catch {
      // Invalid FTS query — fall through.
    }
  }

  const searched = searchArticlesByTokens(db, {
    queryTokens: queryTokens.length ? queryTokens : matchTokens,
    limit: safeLimit,
    offset: safeOffset,
    categoryId,
    confirmedOnly,
  });
  attachKnowledgeImages(db, searched.articles);
  return searched;
}

export {
  ARTICLE_SELECT,
  ARTICLE_FROM,
  tokenizeKnowledgeQuery,
  mapArticle,
  listKnowledgeArticles,
};
