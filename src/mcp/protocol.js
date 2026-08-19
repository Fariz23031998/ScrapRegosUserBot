const crypto = require('crypto');
const express = require('express');

const PROTOCOL_LATEST = '2025-03-26';
const PROTOCOL_ACCEPTED = new Set(['2025-03-26', '2024-11-05']);
const MCP_ACTOR = { type: 'mcp' };

function getMcpToken() {
  return String(process.env.MCP_TOKEN || '').trim();
}

function isEnvFlag(name) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
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

function negotiateProtocol(requested) {
  const version = String(requested || '').trim();
  if (PROTOCOL_ACCEPTED.has(version)) return version;
  return PROTOCOL_LATEST;
}

async function handleJsonRpc(body, { serverInfo, listTools, callTool } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, payload: jsonRpcError(null, -32600, 'Invalid Request') };
  }
  if (body.jsonrpc !== '2.0') {
    return { status: 400, payload: jsonRpcError(body.id ?? null, -32600, 'Invalid Request') };
  }

  const isNotification = !Object.prototype.hasOwnProperty.call(body, 'id');
  const id = isNotification ? undefined : body.id;
  const method = String(body.method || '');
  const params =
    body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {};

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
        serverInfo,
      }),
    };
  }

  if (method === 'ping') {
    return { status: 200, payload: jsonRpcResult(id, {}) };
  }

  if (method === 'tools/list') {
    const tools = await listTools();
    return { status: 200, payload: jsonRpcResult(id, { tools: Array.isArray(tools) ? tools : [] }) };
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
    const result = await callTool(name, args);
    return { status: 200, payload: jsonRpcResult(id, result) };
  }

  return { status: 200, payload: jsonRpcError(id, -32601, `Method not found: ${method}`) };
}

function methodNotAllowed(_req, res) {
  res.setHeader('Allow', 'POST');
  return res.status(405).json({ message: 'Method Not Allowed' });
}

function createMcpRouter({ path: routePath = '/mcp', serverInfo, listTools, callTool } = {}) {
  const router = express.Router();

  router.get(routePath, methodNotAllowed);
  router.delete(routePath, methodNotAllowed);
  router.post(routePath, express.json({ limit: '1mb' }), requireMcpAuth, async (req, res) => {
    try {
      const result = await handleJsonRpc(req.body, {
        serverInfo,
        listTools: () => listTools(),
        callTool: (name, args) => callTool(name, args),
      });
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
  PROTOCOL_ACCEPTED,
  MCP_ACTOR,
  getMcpToken,
  isEnvFlag,
  textResult,
  errorResult,
  jsonRpcResult,
  jsonRpcError,
  handleJsonRpc,
  createMcpRouter,
};
