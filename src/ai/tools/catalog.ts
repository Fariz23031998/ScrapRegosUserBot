/** Catalog of toggleable AI agent tools (settings UI + filtering). */

import { AGENT_TOOL_CATALOG } from './catalog-entries';

const BROWSE_TOOL_NAMES: Set<any> = new Set(['web_search', 'browse_url']);

const KNOWN_TOOL_NAMES: Set<any> = new Set(AGENT_TOOL_CATALOG.map((tool?: any) => tool.name));
const TOOL_AGENTS_BY_NAME: Map<any, any> = new Map(AGENT_TOOL_CATALOG.map((tool?: any) => [tool.name, tool.agents]));
const TOOL_DEFAULT_AGENTS_BY_NAME: Map<any, any> = new Map(
  AGENT_TOOL_CATALOG.map((tool?: any) => [
    tool.name,
    Array.isArray(tool.defaultAgents) ? tool.defaultAgents.filter(Boolean) : [],
  ]),
);
const TOOL_AGENT_SLUGS = ['customer', 'customer_assist', 'kb', 'ops'];

function isKnownAgentTool(name?: any) {
  return KNOWN_TOOL_NAMES.has(String(name || ''));
}

function isToolAgentSlug(slug?: any) {
  return TOOL_AGENT_SLUGS.includes(String(slug || ''));
}

function agentsForTool(name?: any) {
  return [...(TOOL_AGENTS_BY_NAME.get(String(name || '')) || [])];
}

function defaultAgentsForTool(name?: any) {
  const listed = TOOL_DEFAULT_AGENTS_BY_NAME.get(String(name || '')) || [];
  return listed.filter(isToolAgentSlug);
}

function toolBelongsToAgent(name?: any, slug?: any) {
  return agentsForTool(name).includes(String(slug || ''));
}

function emptyDisabledAgentTools() {
  return Object.fromEntries(TOOL_AGENT_SLUGS.map((slug?: any) => [slug, []]));
}

function emptyDefaultAgentTools() {
  return emptyDisabledAgentTools();
}

function catalogDefaultAgentTools() {
  const next = emptyDefaultAgentTools();
  for (const tool of AGENT_TOOL_CATALOG) {
    for (const slug of defaultAgentsForTool(tool.name)) {
      if (!next[slug].includes(tool.name)) next[slug].push(tool.name);
    }
  }
  return next;
}

function cloneDisabledAgentTools(map?: any) {
  const next = emptyDisabledAgentTools();
  if (!map || typeof map !== 'object' || Array.isArray(map)) return next;
  for (const slug of TOOL_AGENT_SLUGS) {
    next[slug] = Array.isArray(map[slug]) ? [...map[slug]] : [];
  }
  return next;
}

function cloneDefaultAgentTools(map?: any) {
  return cloneDisabledAgentTools(map);
}

function isDisabledAgentToolsEmpty(map?: any) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return true;
  return TOOL_AGENT_SLUGS.every((slug?: any) => !Array.isArray(map[slug]) || map[slug].length === 0);
}

function isDefaultAgentToolsEmpty(map?: any) {
  return isDisabledAgentToolsEmpty(map);
}

function resolveDefaultAgentTools(stored?: any) {
  if (isDefaultAgentToolsEmpty(stored)) return catalogDefaultAgentTools();
  return cloneDefaultAgentTools(stored);
}

function isDefaultToolForAgent(name: any, slug: any, defaultAgentTools: any = null) {
  const key = String(name || '');
  const agent = String(slug || '');
  if (defaultAgentTools && !isDefaultAgentToolsEmpty(defaultAgentTools)) {
    return (defaultAgentTools[agent] || []).includes(key);
  }
  return defaultAgentsForTool(key).includes(agent);
}

function defaultToolNamesForAgent(slug: any, defaultAgentTools: any = null) {
  const agent = String(slug || '');
  if (defaultAgentTools && !isDefaultAgentToolsEmpty(defaultAgentTools)) {
    return [...(defaultAgentTools[agent] || [])];
  }
  return AGENT_TOOL_CATALOG.filter((tool?: any) => isDefaultToolForAgent(tool.name, agent)).map(
    (tool?: any) => tool.name,
  );
}

function expandDisabledToolsToAgentMap(disabledTools: any = []) {
  const next = emptyDisabledAgentTools();
  for (const item of Array.isArray(disabledTools) ? disabledTools : []) {
    const name = String(item || '').trim();
    if (!name) continue;
    for (const slug of agentsForTool(name)) {
      if (!isToolAgentSlug(slug) || next[slug].includes(name)) continue;
      next[slug].push(name);
    }
  }
  return next;
}

function deriveFullyDisabledTools(disabledAgentTools: any, catalog: any = AGENT_TOOL_CATALOG) {
  const map = cloneDisabledAgentTools(disabledAgentTools);
  const names: any[] = [];
  for (const tool of catalog || []) {
    const agents = Array.isArray(tool.agents) ? tool.agents.filter(isToolAgentSlug) : [];
    if (!agents.length) continue;
    const allDisabled = agents.every((slug?: any) => map[slug].includes(tool.name));
    if (allDisabled) names.push(tool.name);
  }
  return names;
}

function listAgentToolCatalog() {
  const { isBrowseEnabled } = (require('./browse') as typeof import('./browse'));
  const browseEnabled = isBrowseEnabled();
  return AGENT_TOOL_CATALOG.filter((tool?: any) => browseEnabled || !BROWSE_TOOL_NAMES.has(tool.name)).map(
    (tool?: any) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      agents: [...tool.agents],
      default_agents: defaultAgentsForTool(tool.name),
    }),
  );
}

function selectDefaultTools(tools: any, agentSlug: any, defaultAgentTools: any = null) {
  const slug = String(agentSlug || '').trim();
  const list = Array.isArray(tools) ? tools : [];
  if (!slug || !isToolAgentSlug(slug)) return list;
  const defaultNames: Set<any> = new Set(defaultToolNamesForAgent(slug, defaultAgentTools));
  return list.filter((tool?: any) => defaultNames.has(String(tool?.name || '')));
}

function namesDisabledForAgent(disabledAgentTools?: any, agentSlug?: any) {
  if (Array.isArray(disabledAgentTools)) {
    return new Set(
      disabledAgentTools.map((name?: any) => String(name || '').trim()).filter(Boolean),
    );
  }
  if (!disabledAgentTools || typeof disabledAgentTools !== 'object') return new Set();
  const slug = String(agentSlug || '').trim();
  const rows = Array.isArray(disabledAgentTools[slug]) ? disabledAgentTools[slug] : [];
  return new Set(rows.map((name?: any) => String(name || '').trim()).filter(Boolean));
}

function filterEnabledTools(tools: any, disabledAgentTools: any = [], agentSlug?: any) {
  const disabled = namesDisabledForAgent(disabledAgentTools, agentSlug);
  if (!disabled.size) return Array.isArray(tools) ? tools : [];
  return (tools || []).filter((tool?: any) => !disabled.has(String(tool?.name || '')));
}

function prepareAgentTools(tools?: any, options?: any) {
  return (require('../../db/ai-tool-descriptions') as typeof import('../../db/ai-tool-descriptions')).prepareAgentTools(tools, options);
}

export {
  AGENT_TOOL_CATALOG,
  KNOWN_TOOL_NAMES,
  TOOL_AGENT_SLUGS,
  isKnownAgentTool,
  isToolAgentSlug,
  agentsForTool,
  defaultAgentsForTool,
  isDefaultToolForAgent,
  defaultToolNamesForAgent,
  toolBelongsToAgent,
  emptyDisabledAgentTools,
  emptyDefaultAgentTools,
  catalogDefaultAgentTools,
  cloneDisabledAgentTools,
  cloneDefaultAgentTools,
  isDisabledAgentToolsEmpty,
  isDefaultAgentToolsEmpty,
  resolveDefaultAgentTools,
  expandDisabledToolsToAgentMap,
  deriveFullyDisabledTools,
  listAgentToolCatalog,
  selectDefaultTools,
  filterEnabledTools,
  prepareAgentTools,
};
