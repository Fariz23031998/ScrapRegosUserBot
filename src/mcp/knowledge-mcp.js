const {
  listKnowledgeArticles,
  getKnowledgeArticle,
  createKnowledgeArticle,
  updateKnowledgeArticle,
  deleteKnowledgeArticle,
  formatKnowledgeCategoriesForTools,
  listKnowledgeCategories,
  getKnowledgeCategory,
  createKnowledgeCategory,
  updateKnowledgeCategory,
  deleteKnowledgeCategory,
  appendKnowledgeArticleImage,
  stripKnowledgeArticleImage,
} = require('../db/knowledge-articles');
const {
  addKnowledgeImage,
  appendKnowledgeImageMarkdown,
  decodeKnowledgeImageData,
  deleteKnowledgeImage,
  fetchRemoteImageBuffer,
} = require('../db/knowledge-images');
const { logAdminAudit, buildAuditDetails } = require('../db/admin-audit-logs');
const {
  PROTOCOL_LATEST,
  MCP_ACTOR,
  getMcpToken,
  isEnvFlag,
  textResult,
  errorResult,
  createMcpRouter,
} = require('./protocol');

const SERVER_INFO = { name: 'scrapregos-knowledge', version: '1.0.0' };
const INVALID_ARTICLE_CODES = new Set([
  'INVALID_ARTICLE_TITLE',
  'INVALID_ARTICLE_BODY',
  'INVALID_ARTICLE_TAGS',
  'INVALID_ARTICLE_CATEGORY',
  'ARTICLE_LOCKED',
  'INVALID_IMAGE_TYPE',
  'INVALID_IMAGE_SIZE',
  'INVALID_IMAGE_URL',
  'IMAGE_LIMIT_REACHED',
]);
const INVALID_CATEGORY_CODES = new Set(['INVALID_CATEGORY_NAME', 'INVALID_CATEGORY_TAGS']);

function mapImageForMcp(image) {
  if (!image) return null;
  return {
    id: image.id,
    url: image.url,
    original_name: image.original_name || '',
  };
}

function mapArticleForMcp(article) {
  if (!article) return article;
  return {
    ...article,
    images: Array.isArray(article.images) ? article.images.map(mapImageForMcp) : [],
  };
}

function filenameFromUrl(urlString) {
  try {
    const name = decodeURIComponent(new URL(String(urlString)).pathname.split('/').pop() || '');
    return name.slice(0, 200);
  } catch {
    return '';
  }
}

function isKnowledgeReadonly() {
  return isEnvFlag('MCP_KNOWLEDGE_READONLY');
}

function parseSearchCategoryId(value) {
  if (value === undefined) return { categoryId: undefined };
  if (value === null || value === '') return { categoryId: null };
  const id = Number(value);
  if (!Number.isFinite(id) || id <= 0) {
    return { error: 'Invalid category_id.' };
  }
  return { categoryId: id };
}

const READ_TOOLS = [
  {
    name: 'knowledge_search',
    description:
      'Search the project knowledge base by short keywords (2–6 terms; prefer Russian synonyms used in articles). Empty query returns recently updated articles. Optional category_id limits results; call knowledge_list_categories for ids.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Short keyword query. Empty returns recent articles. Do not paste full sentences.',
        },
        limit: { type: 'integer', description: 'Max results (1–200, default 100).' },
        category_id: {
          type: ['integer', 'number', 'null'],
          description:
            'Optional category id. Omit to search all articles. Pass null for uncategorized articles. Use knowledge_list_categories to get ids.',
        },
      },
    },
  },
  {
    name: 'knowledge_get',
    description:
      'Load a full knowledge-base article by id. Body is Markdown; screenshots are listed in images and as ![alt](url) in the body.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'number', 'string'], description: 'Article id' },
      },
      required: ['id'],
    },
  },
  {
    name: 'knowledge_list_categories',
    description: 'List knowledge-base categories (id, name, tags). Call this before assigning category_id.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

const WRITE_TOOLS = [
  {
    name: 'knowledge_create',
    description:
      'Create a new knowledge-base article. Body is Markdown; image links (![alt](url) or [label](https://…png)) render as images. Use knowledge_add_screenshot after create to store screenshots. New articles stay unconfirmed until an admin confirms them.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Article title (required, max 200).' },
        body: { type: 'string', description: 'Markdown article body (required, max 20000).' },
        tags: { type: 'string', description: 'Comma-separated tags.' },
        category_id: {
          type: ['integer', 'number', 'null'],
          description: 'Optional category id. Omit or null for no category.',
        },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'knowledge_update',
    description:
      'Update an existing knowledge-base article. Body is Markdown; image links render as images. Use knowledge_add_screenshot to store screenshots. Omit fields you do not want to change.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'number', 'string'], description: 'Article id' },
        title: { type: 'string' },
        body: { type: 'string', description: 'Markdown article body (max 20000).' },
        tags: { type: 'string' },
        category_id: {
          type: ['integer', 'number', 'null'],
          description: 'Optional category id. Pass null to clear the category.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'knowledge_delete',
    description: 'Delete a knowledge-base article by id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'number', 'string'], description: 'Article id' },
      },
      required: ['id'],
    },
  },
  {
    name: 'knowledge_add_screenshot',
    description:
      'Store a screenshot on an article and append Markdown ![alt](url) to the body. Prefer url (http/https image). data_base64 is for small images only. Fails if the article is locked.',
    inputSchema: {
      type: 'object',
      properties: {
        article_id: { type: ['integer', 'number', 'string'], description: 'Article id' },
        url: { type: 'string', description: 'Public http(s) image URL to download and store. Preferred.' },
        data_base64: { type: 'string', description: 'Raw or data-URL base64 image (JPEG, PNG, WebP, GIF).' },
        filename: { type: 'string', description: 'Original file name (optional).' },
        alt: { type: 'string', description: 'Alt text for the Markdown image (optional).' },
      },
      required: ['article_id'],
    },
  },
  {
    name: 'knowledge_delete_screenshot',
    description: 'Delete a stored screenshot from an article and remove its Markdown image from the body.',
    inputSchema: {
      type: 'object',
      properties: {
        article_id: { type: ['integer', 'number', 'string'], description: 'Article id' },
        image_id: { type: ['integer', 'number', 'string'], description: 'Screenshot id from knowledge_get images.' },
      },
      required: ['article_id', 'image_id'],
    },
  },
  {
    name: 'knowledge_create_category',
    description: 'Create a knowledge-base category.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Category name (required, max 100).' },
        tags: { type: 'string', description: 'Comma-separated tags.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'knowledge_update_category',
    description: 'Update a knowledge-base category. Omit fields you do not want to change.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'number', 'string'], description: 'Category id' },
        name: { type: 'string' },
        tags: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'knowledge_delete_category',
    description: 'Delete a knowledge-base category. Articles in it become uncategorized.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'number', 'string'], description: 'Category id' },
      },
      required: ['id'],
    },
  },
];

const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((tool) => tool.name));
const CATEGORY_DESC_TOOLS = new Set(['knowledge_create', 'knowledge_update']);

function withLiveCategoryLine(tool, categoryLine) {
  const properties = { ...tool.inputSchema.properties };
  if (properties.category_id) {
    properties.category_id = {
      ...properties.category_id,
      description: `${properties.category_id.description} ${categoryLine}`.trim(),
    };
  }
  return {
    ...tool,
    description: `${tool.description} ${categoryLine}`.trim(),
    inputSchema: {
      ...tool.inputSchema,
      properties,
    },
  };
}

function listMcpTools(db) {
  const tools = isKnowledgeReadonly() ? [...READ_TOOLS] : [...READ_TOOLS, ...WRITE_TOOLS];
  if (!db || isKnowledgeReadonly()) return tools;
  const categoryLine = formatKnowledgeCategoriesForTools(db);
  return tools.map((tool) =>
    CATEGORY_DESC_TOOLS.has(tool.name) ? withLiveCategoryLine(tool, categoryLine) : tool
  );
}

function auditKnowledgeWrite(db, entry) {
  try {
    logAdminAudit(db, { ...entry, actor: MCP_ACTOR });
  } catch (error) {
    console.error('[mcp] Audit log write failed:', error);
  }
}

async function callTool(db, name, args = {}) {
  if (WRITE_TOOL_NAMES.has(name) && isKnowledgeReadonly()) {
    return errorResult('Knowledge base is read-only.');
  }

  switch (name) {
    case 'knowledge_search': {
      const queryUsed = args.query == null ? '' : String(args.query);
      const parsedCategory = parseSearchCategoryId(args.category_id);
      if (parsedCategory.error) return errorResult(parsedCategory.error);
      const { articles } = listKnowledgeArticles(db, {
        query: args.query,
        limit: args.limit,
        categoryId: parsedCategory.categoryId,
      });
      const payload = {
        query_used: queryUsed.trim(),
        articles: articles.map((article) => ({
          id: article.id,
          title: article.title,
          tags: article.tags,
          category_id: article.category_id ?? null,
          category: article.category?.name || null,
          excerpt: String(article.body || '').slice(0, 400),
          locked: Boolean(article.locked),
          updated_at: article.updated_at,
        })),
      };
      if (parsedCategory.categoryId !== undefined) payload.category_id = parsedCategory.categoryId;
      return textResult(payload);
    }
    case 'knowledge_get': {
      const article = getKnowledgeArticle(db, args.id);
      if (!article) return errorResult('Article not found.', { id: args.id });
      return textResult({ article: mapArticleForMcp(article) });
    }
    case 'knowledge_list_categories': {
      return textResult({ categories: listKnowledgeCategories(db) });
    }
    case 'knowledge_create': {
      try {
        const article = createKnowledgeArticle(
          db,
          {
            title: args.title,
            body: args.body,
            tags: args.tags,
            category_id: args.category_id,
          },
          { creator: 'mcp' }
        );
        auditKnowledgeWrite(db, {
          entityType: 'knowledge_article',
          entityId: article.id,
          action: 'create',
          summary: `Создана статья «${article.title}»`,
          details: buildAuditDetails({ before: null, after: article }),
        });
        return textResult({ article: mapArticleForMcp(article) });
      } catch (error) {
        if (INVALID_ARTICLE_CODES.has(error.message)) {
          return errorResult('Invalid article data.', { code: error.message });
        }
        throw error;
      }
    }
    case 'knowledge_update': {
      try {
        const before = getKnowledgeArticle(db, args.id);
        const patch = {
          title: args.title,
          body: args.body,
          tags: args.tags,
        };
        if (args.category_id !== undefined) patch.category_id = args.category_id;
        const article = updateKnowledgeArticle(db, args.id, patch);
        auditKnowledgeWrite(db, {
          entityType: 'knowledge_article',
          entityId: article.id,
          action: 'update',
          summary: `Изменена статья #${article.id}`,
          details: buildAuditDetails({ before, after: article }),
        });
        return textResult({ article: mapArticleForMcp(article) });
      } catch (error) {
        if (error.message === 'NOT_FOUND') {
          return errorResult('Article not found.', { id: args.id });
        }
        if (error.message === 'ARTICLE_LOCKED') {
          return errorResult('Article is locked.', { code: error.message, id: args.id });
        }
        if (INVALID_ARTICLE_CODES.has(error.message)) {
          return errorResult('Invalid article data.', { code: error.message });
        }
        throw error;
      }
    }
    case 'knowledge_delete': {
      try {
        const before = getKnowledgeArticle(db, args.id);
        const deleted = deleteKnowledgeArticle(db, args.id);
        if (!deleted) return errorResult('Article not found.', { id: args.id });
        auditKnowledgeWrite(db, {
          entityType: 'knowledge_article',
          entityId: before.id,
          action: 'delete',
          summary: `Удалена статья #${before.id}`,
          details: buildAuditDetails({ before, after: null }),
        });
        return textResult({ ok: true, id: before.id });
      } catch (error) {
        if (error.message === 'ARTICLE_LOCKED') {
          return errorResult('Article is locked.', { code: error.message, id: args.id });
        }
        throw error;
      }
    }
    case 'knowledge_add_screenshot': {
      try {
        const article = getKnowledgeArticle(db, args.article_id);
        if (!article) return errorResult('Article not found.', { id: args.article_id });
        if (article.locked) return errorResult('Article is locked.', { code: 'ARTICLE_LOCKED', id: article.id });
        const hasData = args.data_base64 != null && String(args.data_base64).trim() !== '';
        const hasUrl = args.url != null && String(args.url).trim() !== '';
        if (hasData === hasUrl) {
          return errorResult('Provide exactly one of url or data_base64.');
        }
        let buffer;
        let originalName = String(args.filename || '').trim();
        if (hasData) {
          buffer = decodeKnowledgeImageData(args.data_base64);
        } else {
          buffer = await fetchRemoteImageBuffer(args.url);
          if (!originalName) originalName = filenameFromUrl(args.url);
        }
        const image = addKnowledgeImage(db, article.id, {
          buffer,
          originalName: originalName || 'screenshot',
        });
        const markdown = appendKnowledgeImageMarkdown('', image, args.alt || originalName).trim();
        const updated = appendKnowledgeArticleImage(db, article, image, args.alt || originalName);
        auditKnowledgeWrite(db, {
          entityType: 'knowledge_article',
          entityId: updated.id,
          action: 'update',
          summary: `Добавлен скриншот статьи #${updated.id}`,
          details: buildAuditDetails({ before: article, after: updated }),
        });
        return textResult({
          image: { ...mapImageForMcp(image), markdown },
          article: mapArticleForMcp(updated),
          markdown,
        });
      } catch (error) {
        if (error.message === 'NOT_FOUND') {
          return errorResult('Article not found.', { id: args.article_id });
        }
        if (error.message === 'ARTICLE_LOCKED') {
          return errorResult('Article is locked.', { code: error.message, id: args.article_id });
        }
        if (INVALID_ARTICLE_CODES.has(error.message)) {
          return errorResult('Invalid screenshot data.', { code: error.message });
        }
        throw error;
      }
    }
    case 'knowledge_delete_screenshot': {
      try {
        const before = getKnowledgeArticle(db, args.article_id);
        if (!before) return errorResult('Article not found.', { id: args.article_id });
        if (before.locked) return errorResult('Article is locked.', { code: 'ARTICLE_LOCKED', id: before.id });
        const image = deleteKnowledgeImage(db, before.id, args.image_id);
        const article = stripKnowledgeArticleImage(db, before, image);
        auditKnowledgeWrite(db, {
          entityType: 'knowledge_article',
          entityId: article.id,
          action: 'update',
          summary: `Удалён скриншот статьи #${article.id}`,
          details: buildAuditDetails({ before, after: article }),
        });
        return textResult({ ok: true, id: image.id, article: mapArticleForMcp(article) });
      } catch (error) {
        if (error.message === 'NOT_FOUND') {
          return errorResult('Screenshot not found.', { article_id: args.article_id, image_id: args.image_id });
        }
        if (error.message === 'ARTICLE_LOCKED') {
          return errorResult('Article is locked.', { code: error.message, id: args.article_id });
        }
        throw error;
      }
    }
    case 'knowledge_create_category': {
      try {
        const category = createKnowledgeCategory(db, { name: args.name, tags: args.tags });
        auditKnowledgeWrite(db, {
          entityType: 'knowledge_category',
          entityId: category.id,
          action: 'create',
          summary: `Создана категория «${category.name}»`,
          details: buildAuditDetails({ before: null, after: category }),
        });
        return textResult({ category });
      } catch (error) {
        if (INVALID_CATEGORY_CODES.has(error.message)) {
          return errorResult('Invalid category data.', { code: error.message });
        }
        throw error;
      }
    }
    case 'knowledge_update_category': {
      try {
        const before = getKnowledgeCategory(db, args.id);
        const category = updateKnowledgeCategory(db, args.id, { name: args.name, tags: args.tags });
        auditKnowledgeWrite(db, {
          entityType: 'knowledge_category',
          entityId: category.id,
          action: 'update',
          summary: `Изменена категория #${category.id}`,
          details: buildAuditDetails({ before, after: category }),
        });
        return textResult({ category });
      } catch (error) {
        if (error.message === 'NOT_FOUND') {
          return errorResult('Category not found.', { id: args.id });
        }
        if (INVALID_CATEGORY_CODES.has(error.message)) {
          return errorResult('Invalid category data.', { code: error.message });
        }
        throw error;
      }
    }
    case 'knowledge_delete_category': {
      const before = getKnowledgeCategory(db, args.id);
      const deleted = deleteKnowledgeCategory(db, args.id);
      if (!deleted) return errorResult('Category not found.', { id: args.id });
      auditKnowledgeWrite(db, {
        entityType: 'knowledge_category',
        entityId: before.id,
        action: 'delete',
        summary: `Удалена категория #${before.id}`,
        details: buildAuditDetails({ before, after: null }),
      });
      return textResult({ ok: true, id: before.id });
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

function createKnowledgeMcpRouter(db) {
  return createMcpRouter({
    path: '/mcp',
    jsonLimit: '8mb',
    serverInfo: SERVER_INFO,
    listTools: () => listMcpTools(db),
    callTool: (name, args) => callTool(db, name, args),
  });
}

module.exports = {
  PROTOCOL_LATEST,
  createKnowledgeMcpRouter,
  getMcpToken,
  isKnowledgeReadonly,
};
