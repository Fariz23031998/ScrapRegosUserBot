import type { Unchecked } from '../../types/unchecked';
import type { Db } from '../../types/db';
import { listKnowledgeArticles, getKnowledgeArticle, createKnowledgeArticle, updateKnowledgeArticle, deleteKnowledgeArticle, formatKnowledgeCategoriesForTools, listKnowledgeCategories, createKnowledgeCategory, updateKnowledgeCategory, deleteKnowledgeCategory } from '../../db/knowledge-articles';
import { createBrowseTools } from './browse';
import { factoryToolDescription } from './descriptions';

function mapArticleCategory(article?: any) {
  return {
    category_id: article.category_id ?? null,
    category: article.category?.name || null,
  };
}

function parseToolCategoryId(value?: any) {
  if (value === undefined) return { categoryId: undefined };
  if (value === null || value === '') return { categoryId: null };
  const id = Number(value);
  if (!Number.isFinite(id) || id <= 0) return { error: 'invalid_category' };
  return { categoryId: id };
}

function mapCategoryForTool(category?: any) {
  return {
    id: category.id,
    name: category.name,
    tags: category.tags || '',
  };
}

function createKnowledgeTools({ db, userId = null, write = false, deps = {} }: Unchecked = {}) {
  const categoryLine = formatKnowledgeCategoriesForTools(db);
  const tools: any[] = [
    {
      name: 'search_knowledge',
      description: factoryToolDescription('search_knowledge', categoryLine),
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Short keyword query, not the full user message',
          },
          category_id: {
            type: ['number', 'null'],
            description: `Optional category id. Omit to search all articles. Pass null for uncategorized articles. ${categoryLine}`,
          },
        },
        required: ['query'],
      },
      execute: async ({ query, category_id }: Unchecked = {}) => {
        const queryUsed = String(query || '').trim();
        const parsed = parseToolCategoryId(category_id);
        if (parsed.error) return { ok: false, error: parsed.error };
        const { articles } = listKnowledgeArticles(db, {
          query: queryUsed,
          limit: 8,
          categoryId: parsed.categoryId,
          confirmedOnly: true,
        });
        const result: Unchecked = {
          query_used: queryUsed,
          articles: articles.map((article?: any) => ({
            id: article.id,
            title: article.title,
            tags: article.tags,
            ...mapArticleCategory(article),
            locked: Boolean(article.locked),
            excerpt: String(article.body || '').slice(0, 400),
          })),
        };
        if (parsed.categoryId !== undefined) result.category_id = parsed.categoryId;
        return result;
      },
    },
    {
      name: 'get_article',
      description: factoryToolDescription('get_article'),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Article id' },
        },
        required: ['id'],
      },
      execute: async ({ id }: Unchecked) => {
        const article = getKnowledgeArticle(db, id, { confirmedOnly: true });
        return article || { ok: false, error: 'not_found' };
      },
    },
    {
      name: 'list_knowledge_categories',
      description: factoryToolDescription('list_knowledge_categories'),
      parameters: { type: 'object', properties: {} },
      execute: async () => ({
        categories: listKnowledgeCategories(db).map(mapCategoryForTool),
      }),
    },
    ...createBrowseTools({ deps }),
  ];

  if (!write) return tools;

  function runWritable(fn?: any) {
    try {
      return fn();
    } catch (error: any) {
      if (error.message === 'ARTICLE_LOCKED') return { ok: false, error: 'locked' };
      if (error.message === 'NOT_FOUND') return { ok: false, error: 'not_found' };
      if (error.message === 'INVALID_ARTICLE_CATEGORY') return { ok: false, error: 'invalid_category' };
      if (error.message === 'INVALID_CATEGORY_NAME') return { ok: false, error: 'invalid_category_name' };
      if (error.message === 'INVALID_CATEGORY_TAGS') return { ok: false, error: 'invalid_category_tags' };
      throw error;
    }
  }

  tools.push(
    {
      name: 'create_article',
      description: factoryToolDescription('create_article', categoryLine),
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string', description: 'Markdown article body (max 20000)' },
          tags: { type: 'string', description: 'Comma-separated tags' },
          category_id: {
            type: ['number', 'null'],
            description: `Optional category id. Omit or null for no category. ${categoryLine}`,
          },
        },
        required: ['title', 'body'],
      },
      execute: async ({ title, body, tags, category_id }: Unchecked) =>
        runWritable(() =>
          createKnowledgeArticle(db, { title, body, tags, category_id }, {
            updatedBy: userId,
            creator: userId != null ? String(userId) : null,
          })
        ),
    },
    {
      name: 'update_article',
      description: factoryToolDescription('update_article', categoryLine),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          title: { type: 'string' },
          body: { type: 'string', description: 'Markdown article body (max 20000)' },
          tags: { type: 'string' },
          category_id: {
            type: ['number', 'null'],
            description: `Optional category id. Pass null to clear the category. ${categoryLine}`,
          },
        },
        required: ['id'],
      },
      execute: async ({ id, title, body, tags, category_id }: Unchecked) =>
        runWritable(() => {
          const patch: Unchecked = { title, body, tags };
          if (category_id !== undefined) patch.category_id = category_id;
          return updateKnowledgeArticle(db, id, patch, { updatedBy: userId });
        }),
    },
    {
      name: 'delete_article',
      description: factoryToolDescription('delete_article'),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number' },
        },
        required: ['id'],
      },
      execute: async ({ id }: Unchecked) => runWritable(() => ({ ok: deleteKnowledgeArticle(db, id) })),
    },
    {
      name: 'create_category',
      description: factoryToolDescription('create_category'),
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Category name' },
          tags: { type: 'string', description: 'Comma-separated tags' },
        },
        required: ['name'],
      },
      execute: async ({ name, tags }: Unchecked = {}) =>
        runWritable(() => createKnowledgeCategory(db, { name, tags })),
    },
    {
      name: 'update_category',
      description: factoryToolDescription('update_category'),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          name: { type: 'string' },
          tags: { type: 'string' },
        },
        required: ['id'],
      },
      execute: async ({ id, name, tags }: Unchecked = {}) =>
        runWritable(() => {
          const patch: Unchecked = {};
          if (name !== undefined) patch.name = name;
          if (tags !== undefined) patch.tags = tags;
          return updateKnowledgeCategory(db, id, patch);
        }),
    },
    {
      name: 'delete_category',
      description: factoryToolDescription('delete_category'),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number' },
        },
        required: ['id'],
      },
      execute: async ({ id }: Unchecked = {}) =>
        runWritable(() => {
          const deleted = deleteKnowledgeCategory(db, id);
          if (!deleted) throw new Error('NOT_FOUND');
          return { ok: true, id: Number(id) };
        }),
    }
  );

  return tools;
}

export { createKnowledgeTools };
