const {
  listKnowledgeArticles,
  getKnowledgeArticle,
  createKnowledgeArticle,
  updateKnowledgeArticle,
  deleteKnowledgeArticle,
} = require('../../db/knowledge-articles');
const { createBrowseTools } = require('./browse');

function createKnowledgeTools({ db, userId = null, write = false, deps = {} } = {}) {
  const tools = [
    {
      name: 'search_knowledge',
      description: 'Search the internal knowledge base by keywords. Use this before answering questions about prices, handoff, or procedures.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
      execute: async ({ query }) => {
        const { articles } = listKnowledgeArticles(db, { query, limit: 8 });
        return {
          articles: articles.map((article) => ({
            id: article.id,
            title: article.title,
            tags: article.tags,
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
      throw error;
    }
  }

  tools.push(
    {
      name: 'create_article',
      description: 'Create a new knowledge-base article.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          tags: { type: 'string', description: 'Comma-separated tags' },
        },
        required: ['title', 'body'],
      },
      execute: async ({ title, body, tags }) =>
        createKnowledgeArticle(db, { title, body, tags }, { updatedBy: userId }),
    },
    {
      name: 'update_article',
      description: 'Update an existing knowledge-base article. Omit fields you do not want to change. Locked articles cannot be updated.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          title: { type: 'string' },
          body: { type: 'string' },
          tags: { type: 'string' },
        },
        required: ['id'],
      },
      execute: async ({ id, title, body, tags }) =>
        runWritable(() => updateKnowledgeArticle(db, id, { title, body, tags }, { updatedBy: userId })),
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
