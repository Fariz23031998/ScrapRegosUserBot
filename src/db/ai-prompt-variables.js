const vm = require('node:vm');

const MAX_NAME = 120;
const MAX_KEY = 64;
const MAX_SOURCE = 8000;
const MAX_RESULT = 4000;
const MAX_QUERY_ROWS = 200;
const MAX_SQL_LENGTH = 4000;
const VARIABLE_TIMEOUT_MS = 500;
const VARIABLE_COLUMNS = 'id, key, name, source, updated_by, created_at, updated_at';
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const TOKEN_RE = /\{\{([a-z][a-z0-9_]*)\}\}/g;
const WRITE_SQL_RE =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|REPLACE\s+INTO|LOAD_EXTENSION)\b/i;

function ensureAiPromptVariablesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_prompt_variables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      updated_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function normalizeKey(key) {
  const value = String(key || '').trim();
  if (!KEY_PATTERN.test(value) || value.length > MAX_KEY) throw new Error('INVALID_VARIABLE_KEY');
  return value;
}

function normalizeName(name) {
  const text = String(name || '').trim();
  if (!text || text.length > MAX_NAME) throw new Error('INVALID_VARIABLE_NAME');
  return text;
}

function normalizeSource(source) {
  const text = String(source || '').trim();
  if (!text || text.length > MAX_SOURCE) throw new Error('INVALID_VARIABLE_SOURCE');
  return text;
}

function normalizeVariableId(id) {
  const value = Number(id);
  if (!Number.isInteger(value) || value <= 0) throw new Error('VARIABLE_NOT_FOUND');
  return value;
}

function serializeVariable(row) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    source: row.source,
    updated_at: row.updated_at || null,
    updated_by: row.updated_by ?? null,
  };
}

function getStoredVariable(db, id) {
  ensureAiPromptVariablesTable(db);
  return (
    db
      .prepare(`SELECT ${VARIABLE_COLUMNS} FROM ai_prompt_variables WHERE id = ?`)
      .get(normalizeVariableId(id)) || null
  );
}

function findVariableByKey(db, key, excludeId = null) {
  ensureAiPromptVariablesTable(db);
  if (excludeId != null) {
    return (
      db
        .prepare('SELECT id FROM ai_prompt_variables WHERE key = ? AND id != ?')
        .get(key, excludeId) || null
    );
  }
  return db.prepare('SELECT id FROM ai_prompt_variables WHERE key = ?').get(key) || null;
}

function listPromptVariables(db) {
  ensureAiPromptVariablesTable(db);
  return db
    .prepare(
      `SELECT ${VARIABLE_COLUMNS} FROM ai_prompt_variables ORDER BY key ASC, id ASC`
    )
    .all()
    .map(serializeVariable);
}

function getPromptVariable(db, id) {
  const stored = getStoredVariable(db, id);
  if (!stored) throw new Error('VARIABLE_NOT_FOUND');
  return serializeVariable(stored);
}

function createPromptVariable(db, input = {}, { updatedBy } = {}) {
  const key = normalizeKey(input.key);
  const name = normalizeName(input.name);
  const source = normalizeSource(input.source);
  ensureAiPromptVariablesTable(db);
  if (findVariableByKey(db, key)) throw new Error('VARIABLE_KEY_TAKEN');
  const result = db
    .prepare(
      `INSERT INTO ai_prompt_variables (key, name, source, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .run(key, name, source, updatedBy ?? null);
  return getPromptVariable(db, Number(result.lastInsertRowid));
}

function updatePromptVariable(db, id, input = {}, { updatedBy } = {}) {
  const stored = getStoredVariable(db, id);
  if (!stored) throw new Error('VARIABLE_NOT_FOUND');
  const key = normalizeKey(input.key ?? stored.key);
  const name = normalizeName(input.name ?? stored.name);
  const source = normalizeSource(input.source ?? stored.source);
  if (findVariableByKey(db, key, stored.id)) throw new Error('VARIABLE_KEY_TAKEN');
  db.prepare(
    `UPDATE ai_prompt_variables
     SET key = ?, name = ?, source = ?, updated_by = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(key, name, source, updatedBy ?? null, stored.id);
  return getPromptVariable(db, stored.id);
}

function deletePromptVariable(db, id) {
  const stored = getStoredVariable(db, id);
  if (!stored) throw new Error('VARIABLE_NOT_FOUND');
  db.prepare('DELETE FROM ai_prompt_variables WHERE id = ?').run(stored.id);
  return { ok: true, variable: serializeVariable(stored) };
}

function stripSqlComments(sql) {
  return String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;+\s*$/, '');
}

function assertSelectOnly(sql) {
  const text = stripSqlComments(sql);
  if (!text || text.length > MAX_SQL_LENGTH) throw new Error('QUERY_NOT_ALLOWED');
  if (text.includes(';')) throw new Error('QUERY_NOT_ALLOWED');
  if (!/^(SELECT|WITH)\b/i.test(text)) throw new Error('QUERY_NOT_ALLOWED');
  if (WRITE_SQL_RE.test(text)) throw new Error('QUERY_NOT_ALLOWED');
}

function createQueryFn(db) {
  return function query(sql, params) {
    assertSelectOnly(sql);
    const values = Array.isArray(params) ? params : params == null ? [] : [params];
    const rows = db.prepare(String(sql)).all(...values);
    if (!Array.isArray(rows)) return [];
    return rows.length > MAX_QUERY_ROWS ? rows.slice(0, MAX_QUERY_ROWS) : rows;
  };
}

function shapeTicketContext(ticket, client) {
  const ticketSource = ticket && typeof ticket === 'object' ? ticket : {};
  const clientSource = client && typeof client === 'object' ? client : ticketSource.client || {};
  return {
    ticket: {
      id: ticketSource.id ?? null,
      status: ticketSource.status || null,
      subject: ticketSource.subject || null,
      chat_id: ticketSource.chat_id ?? null,
      client_id: ticketSource.client_id ?? clientSource.id ?? null,
    },
    client: {
      id: clientSource.id ?? ticketSource.client_id ?? null,
      name: clientSource.name || null,
      phone: clientSource.phone || null,
    },
  };
}

function promptContextFromTicket(ticket) {
  if (!ticket || typeof ticket !== 'object') return {};
  return shapeTicketContext(ticket, ticket.client);
}

function resolvePromptContext(context) {
  if (!context || typeof context !== 'object') return {};
  if (context.ticket || context.client) {
    return shapeTicketContext(context.ticket, context.client);
  }
  if (context.id != null || context.status != null || context.subject != null) {
    return promptContextFromTicket(context);
  }
  return {};
}

function stringifyResult(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.slice(0, MAX_RESULT);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value).slice(0, MAX_RESULT);
  }
  try {
    return JSON.stringify(value).slice(0, MAX_RESULT);
  } catch {
    return String(value).slice(0, MAX_RESULT);
  }
}

function userFacingVariableError(error) {
  const message = String(error?.message || '');
  if (message === 'QUERY_NOT_ALLOWED') return 'Разрешены только SELECT-запросы.';
  if (/timed out/i.test(message)) return 'Превышено время выполнения.';
  if (/INVALID_VARIABLE_SOURCE/.test(message)) return 'Введите тело JavaScript-функции.';
  return message || 'Не удалось выполнить функцию.';
}

function executeVariableSource(db, source, context = {}) {
  const text = String(source || '').trim();
  if (!text || text.length > MAX_SOURCE) throw new Error('INVALID_VARIABLE_SOURCE');
  const sandbox = {
    query: createQueryFn(db),
    context: resolvePromptContext(context),
  };
  vm.createContext(sandbox, { name: 'prompt-variable' });
  const script = new vm.Script(
    `"use strict";\n(function(query, context) {\n${text}\n})(query, context);`,
    { filename: 'prompt-variable.js' }
  );
  return script.runInContext(sandbox, { timeout: VARIABLE_TIMEOUT_MS });
}

function runVariable(db, source, context = {}) {
  try {
    return stringifyResult(executeVariableSource(db, source, context));
  } catch (error) {
    console.error('Prompt variable failed:', error.message || error);
    return '';
  }
}

function testVariableSource(db, source, context = {}) {
  try {
    return { value: stringifyResult(executeVariableSource(db, source, context)) };
  } catch (error) {
    return { error: userFacingVariableError(error) };
  }
}

function interpolatePrompt(db, body, context = {}) {
  const text = String(body || '');
  if (!text.includes('{{')) return text;
  const variables = listPromptVariables(db);
  if (!variables.length) return text;
  const byKey = new Map(variables.map((item) => [item.key, item]));
  const cache = new Map();
  return text.replace(TOKEN_RE, (match, key) => {
    const variable = byKey.get(key);
    if (!variable) return match;
    if (!cache.has(key)) {
      cache.set(key, runVariable(db, variable.source, context));
    }
    return cache.get(key);
  });
}

module.exports = {
  MAX_NAME,
  MAX_KEY,
  MAX_SOURCE,
  MAX_RESULT,
  VARIABLE_TIMEOUT_MS,
  ensureAiPromptVariablesTable,
  listPromptVariables,
  getPromptVariable,
  createPromptVariable,
  updatePromptVariable,
  deletePromptVariable,
  promptContextFromTicket,
  runVariable,
  testVariableSource,
  interpolatePrompt,
};
