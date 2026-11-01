import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { interpolatePrompt, promptContextFromTicket } from './ai-prompt-variables';
import { formatKnowledgeCategoriesForTools } from './knowledge-articles';
import { isKnownAgentTool, isToolAgentSlug, listAgentToolCatalog, filterEnabledTools, selectDefaultTools } from '../ai/tools/catalog';
import { getDefaultToolDescription, appendCategoryLine } from '../ai/tools/descriptions';
import { createSearchToolsTool } from '../ai/tools/search-tools';

const MAX_BODY = 8000;
const TOOL_DESCRIPTION_COLUMNS = 'tool_name, body, updated_by, updated_at';

function ensureAiToolDescriptionsTable(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_tool_descriptions (
      tool_name TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      updated_by INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function normalizeToolName(name?: any) {
  const value = String(name || '').trim();
  if (!isKnownAgentTool(value)) throw new Error('UNKNOWN_TOOL');
  return value;
}

function normalizeBody(body?: any) {
  const text = String(body || '').trim();
  if (text.length > MAX_BODY) throw new Error('INVALID_TOOL_DESCRIPTION');
  return text;
}

function getStoredToolDescriptionRow(db: Db, name?: any) {
  ensureAiToolDescriptionsTable(db);
  return (
    db
      .prepare(`SELECT ${TOOL_DESCRIPTION_COLUMNS} FROM ai_tool_descriptions WHERE tool_name = ?`)
      .get(name) || null
  );
}

function getStoredToolDescription(db: Db, name?: any) {
  const key = String(name || '').trim();
  if (!key) return '';
  const row = getStoredToolDescriptionRow(db, key);
  return String(row?.body || '').trim();
}

function serializeToolDescription(tool: any, row: any = null) {
  const defaultBody = getDefaultToolDescription(tool.name);
  const stored = String(row?.body || '').trim();
  return {
    name: tool.name,
    title: tool.title,
    agents: [...(tool.agents || [])],
    default_agents: [...(tool.default_agents || [])],
    body: stored || defaultBody,
    default_body: defaultBody,
    is_custom: Boolean(stored),
    updated_at: row?.updated_at || null,
    updated_by: row?.updated_by ?? null,
  };
}

function listToolDescriptions(db: Db) {
  ensureAiToolDescriptionsTable(db);
  const rows = db.prepare(`SELECT ${TOOL_DESCRIPTION_COLUMNS} FROM ai_tool_descriptions`).all();
  const byName: Map<any, any> = new Map(rows.map((row?: any) => [row.tool_name, row]));
  return listAgentToolCatalog().map((tool?: any) => serializeToolDescription(tool, byName.get(tool.name) || null));
}

function getToolDescription(db: Db, name?: any) {
  const key = normalizeToolName(name);
  const catalog = listAgentToolCatalog().find((tool?: any) => tool.name === key);
  if (!catalog) throw new Error('UNKNOWN_TOOL');
  return serializeToolDescription(catalog, getStoredToolDescriptionRow(db, key));
}

function deleteStoredToolDescription(db: Db, name?: any) {
  ensureAiToolDescriptionsTable(db);
  db.prepare('DELETE FROM ai_tool_descriptions WHERE tool_name = ?').run(name);
}

function saveToolDescription(db: Db, name: any, body: any, { updatedBy }: Unchecked = {}) {
  const key = normalizeToolName(name);
  const text = normalizeBody(body);
  const defaultBody = getDefaultToolDescription(key);
  if (!text || text === defaultBody) {
    deleteStoredToolDescription(db, key);
    return getToolDescription(db, key);
  }
  ensureAiToolDescriptionsTable(db);
  db.prepare(
    `INSERT INTO ai_tool_descriptions (tool_name, body, updated_by, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(tool_name) DO UPDATE SET
       body = excluded.body,
       updated_by = excluded.updated_by,
       updated_at = datetime('now')`,
  ).run(key, text, updatedBy ?? null);
  return getToolDescription(db, key);
}

function resetToolDescription(db: Db, name?: any) {
  const key = normalizeToolName(name);
  deleteStoredToolDescription(db, key);
  return getToolDescription(db, key);
}

function resolveToolDescription(db: Db, toolName?: any, factoryDescription?: any, ticket?: any) {
  const stored = getStoredToolDescription(db, toolName);
  const fallback = getDefaultToolDescription(toolName) || String(factoryDescription || '').trim();
  const body = stored || fallback;
  return interpolatePrompt(db, body, promptContextFromTicket(ticket));
}

function applyToolDescriptions(tools: any, db: Db, ticket?: any) {
  const categoryLine = formatKnowledgeCategoriesForTools(db);
  return (tools || []).map((tool?: any) => {
    const name = String(tool?.name || '');
    const resolved = resolveToolDescription(db, name, tool?.description, ticket);
    return {
      ...tool,
      description: appendCategoryLine(name, resolved, categoryLine),
    };
  });
}

function prepareAgentTools(tools: any, { db, settings, agentSlug, ticket }: Unchecked = {}) {
  const slug = String(agentSlug || '').trim();
  const enabled = filterEnabledTools(tools, settings?.disabledAgentTools, slug);
  let pool = db ? applyToolDescriptions(enabled, db, ticket) : [...enabled];
  const defaultAgentTools = settings?.defaultAgentTools || null;

  if (slug && isToolAgentSlug(slug)) {
    const searchEnabled = filterEnabledTools(
      [{ name: 'search_tools' }],
      settings?.disabledAgentTools,
      slug,
    ).length > 0;
    if (searchEnabled && !pool.some((tool?: any) => tool.name === 'search_tools')) {
      let searchTool = createSearchToolsTool({
        agentSlug: slug,
        getToolPool: () => pool,
        defaultAgentTools,
      });
      if (db) {
        searchTool = applyToolDescriptions([searchTool], db, ticket)[0];
      }
      pool = [...pool, searchTool];
    }
  }

  const activeTools =
    slug && isToolAgentSlug(slug)
      ? selectDefaultTools(pool, slug, defaultAgentTools)
      : pool;

  return { activeTools, toolPool: pool };
}

export {
  MAX_BODY,
  ensureAiToolDescriptionsTable,
  getStoredToolDescription,
  listToolDescriptions,
  getToolDescription,
  saveToolDescription,
  resetToolDescription,
  resolveToolDescription,
  applyToolDescriptions,
  prepareAgentTools,
};
