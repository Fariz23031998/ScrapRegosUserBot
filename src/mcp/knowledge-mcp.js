const crypto = require('crypto');
const express = require('express');
const {
  listKnowledgeArticles,
  getKnowledgeArticle,
  createKnowledgeArticle,
  updateKnowledgeArticle,
  deleteKnowledgeArticle,
} = require('../db/knowledge-articles');
const { logAdminAudit, buildAuditDetails } = require('../db/admin-audit-logs');

const PROTOCOL_LATEST = '2025-03-26';
const PROTOCOL_ACCEPTED = new Set(['2025-03-26', '2024-11-05']);
const SERVER_INFO = { name: 'scrapregos-knowledge', version: '1.0.0' };
const MCP_ACTOR = { type: 'mcp' };
const INVALID_ARTICLE_CODES = new Set([
  'INVALID_ARTICLE_TITLE',
  'INVALID_ARTICLE_BODY',
  'INVALID_ARTICLE_TAGS',
  'ARTICLE_LOCKED',
]);

function getMcpToken() {
  return String(process.env.MCP_TOKEN || '').trim();
}

function isKnowledgeReadonly() {
  const raw = String(process.env.MCP_KNOWLEDGE_READONLY || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (!left.length || left.length !== right.length) {
    crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  try {
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function extractProvidedToken(req) {
  const header = String(req.headers.authorization || '').trim();
  const bearer = header.match(/^Bearer\s+(\S+)/i);
  if (bearer) return bearer[1].trim();
  const alt = req.headers['x-mcp-token'];
  if (alt == null) return '';
  return String(Array.isArray(alt) ? alt[0] : alt).trim();
}

function requireMcpAuth(req, res, next) {
  const expected = getMcpToken();
  if (!expected) {
    return res.status(503).json({ message: 'MCP is not configured.' });
  }
  const provided = extractProvidedToken(req);
  if (!provided || provided.length > 1024 || !timingSafeEqualString(provided, expected)) {
    return res.status(401).json({ message: 'Unauthorized.' });
  }
  return next();
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function textResult(payload, { isError = false } = {}) {
  const result = {
    content: [
      {
        type: 'text',
        text: typeof payload === 'string' ? payload : JSON.stringify(payload),
      },
    ],
  };
  if (isError) result.isError = true;
  return result;
}

function errorResult(message, extra) {
  return textResult(extra ? { error: message, ...extra } : { error: message }, { isError: true });
}

const READ_TOOLS = [
  {
    name: 'knowledge_search',
    description:
      'Search the project knowledge base by keywords. Empty query returns recently updated articles.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query. Empty returns recent articles.' },
        limit: { type: 'integer', description: 'Max results (1–200, default 100).' },
      },
    },
  },
  {
    name: 'knowledge_get',
    description: 'Load a full knowledge-base article by id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'number', 'string'], description: 'Article id' },
      },
      required: ['id'],
    },
  },
];

const WRITE_TOOLS = [
  {
    name: 'knowledge_create',
    description: 'Create a new knowledge-base article.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Article title (required, max 200).' },
        body: { type: 'string', description: 'Article body (required, max 20000).' },
        tags: { type: 'string', description: 'Comma-separated tags.' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'knowledge_update',
    description: 'Update an existing knowledge-base article. Omit fields you do not want to change.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'number', 'string'], description: 'Article id' },
        title: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'string' },
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
];

const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((tool) => tool.name));

function listMcpTools() {
  return isKnowledgeReadonly() ? [...READ_TOOLS] : [...READ_TOOLS, ...WRITE_TOOLS];
}

function auditKnowledgeWrite(db, entry) {
  try {
    logAdminAudit(db, { ...entry, actor: MCP_ACTOR });
  } catch (error) {
    console.error('[mcp] Audit log write failed:', error);
  }
}

function callTool(db, name, args = {}) {
  if (WRITE_TOOL_NAMES.has(name) && isKnowledgeReadonly()) {
    return errorResult('Knowledge base is read-only.');
  }

  switch (name) {
    case 'knowledge_search': {
      const { articles } = listKnowledgeArticles(db, {
        query: args.query,
        limit: args.limit,
      });
      return textResult({
        articles: articles.map((article) => ({
          id: article.id,
          title: article.title,
          tags: article.tags,
          excerpt: String(article.body || '').slice(0, 400),
          locked: Boolean(article.locked),
          updated_at: article.updated_at,
        })),
      });
    }
    case 'knowledge_get': {
      const article = getKnowledgeArticle(db, args.id);
      if (!article) return errorResult('Article not found.', { id: args.id });
      return textResult({ article });
    }
    case 'knowledge_create': {
      try {
        const article = createKnowledgeArticle(db, {
          title: args.title,
          body: args.body,
          tags: args.tags,
        });
        auditKnowledgeWrite(db, {
          entityType: 'knowledge_article',
          entityId: article.id,
          action: 'create',
          summary: `Создана статья «${article.title}»`,
          details: buildAuditDetails({ before: null, after: article }),
        });
        return textResult({ article });
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
        const article = updateKnowledgeArticle(db, args.id, {
          title: args.title,
          body: args.body,
          tags: args.tags,
        });
        auditKnowledgeWrite(db, {
          entityType: 'knowledge_article',
          entityId: article.id,
          action: 'update',
          summary: `Изменена статья #${article.id}`,
          details: buildAuditDetails({ before, after: article }),
        });
        return textResult({ article });
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
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

function negotiateProtocol(requested) {
  const version = String(requested || '').trim();
  if (PROTOCOL_ACCEPTED.has(version)) return version;
  return PROTOCOL_LATEST;
}

function handleJsonRpc(db, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, payload: jsonRpcError(null, -32600, 'Invalid Request') };
  }
  if (body.jsonrpc !== '2.0') {
    return { status: 400, payload: jsonRpcError(body.id ?? null, -32600, 'Invalid Request') };
  }

  const isNotification = !Object.prototype.hasOwnProperty.call(body, 'id');
  const id = isNotification ? undefined : body.id;
  const method = String(body.method || '');
  const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params)
    ? body.params
    : {};

  if (method.startsWith('notifications/')) {
    return { status: 202, payload: null };
  }

  if (isNotification) {
    return { status: 202, payload: null };
  }

  if (method === 'initialize') {
    return {
      status: 200,
      payload: jsonRpcResult(id, {
        protocolVersion: negotiateProtocol(params.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }),
    };
  }

  if (method === 'ping') {
    return { status: 200, payload: jsonRpcResult(id, {}) };
  }

  if (method === 'tools/list') {
    return { status: 200, payload: jsonRpcResult(id, { tools: listMcpTools() }) };
  }

  if (method === 'tools/call') {
    const name = String(params.name || '').trim();
    const args =
      params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments
        : {};
    if (!name) {
      return { status: 200, payload: jsonRpcResult(id, errorResult('Tool name is required.')) };
    }
    return { status: 200, payload: jsonRpcResult(id, callTool(db, name, args)) };
  }

  return { status: 200, payload: jsonRpcError(id, -32601, `Method not found: ${method}`) };
}

function methodNotAllowed(_req, res) {
  res.setHeader('Allow', 'POST');
  return res.status(405).json({ message: 'Method Not Allowed' });
}

function createKnowledgeMcpRouter(db) {
  const router = express.Router();

  router.get('/mcp', methodNotAllowed);
  router.delete('/mcp', methodNotAllowed);
  router.post('/mcp', express.json({ limit: '1mb' }), requireMcpAuth, (req, res) => {
    try {
      const result = handleJsonRpc(db, req.body);
      if (result.status === 202) {
        return res.status(202).end();
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('MCP-Protocol-Version', PROTOCOL_LATEST);
      return res.status(result.status).json(result.payload);
    } catch (error) {
      console.error('[mcp] Request failed:', error);
      const id = req.body && typeof req.body === 'object' ? req.body.id ?? null : null;
      return res.status(500).json(jsonRpcError(id, -32603, 'Internal error'));
    }
  });

  return router;
}

module.exports = {
  PROTOCOL_LATEST,
  createKnowledgeMcpRouter,
  getMcpToken,
  isKnowledgeReadonly,
};
