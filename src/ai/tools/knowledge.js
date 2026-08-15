const {
  listKnowledgeArticles,
  getKnowledgeArticle,
  createKnowledgeArticle,
  updateKnowledgeArticle,
  deleteKnowledgeArticle,
  formatKnowledgeCategoriesForTools,
} = require('../../db/knowledge-articles');
const { createBrowseTools } = require('./browse');

function mapArticleCategory(article) {
  return {
    category_id: article.category_id ?? null,
    category: article.category?.name || null,
  };
}

function createKnowledgeTools({ db, userId = null, write = false, deps = {} } = {}) {
  const tools = [
    {
      name: 'search_knowledge',
      description:
        'Search the internal knowledge base by keywords (2–6 short terms). Prefer Russian KB wording and synonyms (e.g. «офис адрес контакты»). Do not paste the full customer sentence.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Short keyword query, not the full user message',
          },
        },
        required: ['query'],
      },
      execute: async ({ query }) => {
        const queryUsed = String(query || '').trim();
        const { articles } = listKnowledgeArticles(db, { query: queryUsed, limit: 8 });
        return {
          query_used: queryUsed,
          articles: articles.map((article) => ({
            id: article.id,
            title: article.title,
            tags: article.tags,
            ...mapArticleCategory(article),
            locked: Boolean(article.locked),
            excerpt: String(article.body || '').slice(0, 400),
          })),
        };
      },
    },
    {
      name: 'get_article',
      description: 'Load a full knowledge-base article by id.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Article id' },
        },
        required: ['id'],
      },
      execute: async ({ id }) => {
        const article = getKnowledgeArticle(db, id);
        return article || { ok: false, error: 'not_found' };
      },
    },
    ...createBrowseTools({ deps }),
  ];

  if (!write) return tools;

  function runWritable(fn) {
    try {
      return fn();
    } catch (error) {
      if (error.message === 'ARTICLE_LOCKED') return { ok: false, error: 'locked' };
      if (error.message === 'NOT_FOUND') return { ok: false, error: 'not_found' };
      if (error.message === 'INVALID_ARTICLE_CATEGORY') return { ok: false, error: 'invalid_category' };
      throw error;
    }
  }

  const categoryLine = formatKnowledgeCategoriesForTools(db);

  tools.push(
    {
      name: 'create_article',
      description: `Create a new knowledge-base article. ${categoryLine}`,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          tags: { type: 'string', description: 'Comma-separated tags' },
          category_id: {
            type: ['number', 'null'],
            description: `Optional category id. Omit or null for no category. ${categoryLine}`,
          },
        },
        required: ['title', 'body'],
      },
      execute: async ({ title, body, tags, category_id }) =>
        runWritable(() =>
          createKnowledgeArticle(db, { title, body, tags, category_id }, { updatedBy: userId })
        ),
    },
    {
      name: 'update_article',
      description: `Update an existing knowledge-base article. Omit fields you do not want to change. Locked articles cannot be updated. ${categoryLine}`,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          title: { type: 'string' },
          body: { type: 'string' },
          tags: { type: 'string' },
          category_id: {
            type: ['number', 'null'],
            description: `Optional category id. Pass null to clear the category. ${categoryLine}`,
          },
        },
        required: ['id'],
      },
      execute: async ({ id, title, body, tags, category_id }) =>
        runWritable(() => {
          const patch = { title, body, tags };
          if (category_id !== undefined) patch.category_id = category_id;
          return updateKnowledgeArticle(db, id, patch, { updatedBy: userId });
        }),
    },
    {
      name: 'delete_article',
      description: 'Delete a knowledge-base article by id. Locked articles cannot be deleted.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number' },
        },
        required: ['id'],
      },
      execute: async ({ id }) => runWritable(() => ({ ok: deleteKnowledgeArticle(db, id) })),
    }
  );

  return tools;
}

module.exports = {
  createKnowledgeTools,
};
