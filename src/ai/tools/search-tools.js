const {
  isDefaultToolForAgent,
  listAgentToolCatalog,
  toolBelongsToAgent,
} = require('./catalog');
const { factoryToolDescription } = require('./descriptions');

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 25;

function tokenizeQuery(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[\s,.;:|/\\_+-]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

function scoreToolMatch(tool, tokens, rawQuery) {
  const name = String(tool?.name || '').toLowerCase();
  const title = String(tool?.title || '').toLowerCase();
  const description = String(tool?.description || '').toLowerCase();
  const haystack = `${name} ${title} ${description}`;
  const q = String(rawQuery || '').trim().toLowerCase();
  let score = 0;
  if (q && (name === q || title === q)) score += 100;
  if (q && (name.includes(q) || title.includes(q))) score += 40;
  for (const token of tokens) {
    if (name === token) score += 50;
    else if (name.includes(token)) score += 25;
    if (title.includes(token)) score += 15;
    if (description.includes(token)) score += 8;
    if (!haystack.includes(token)) score -= 5;
  }
  return score;
}

function searchableToolMeta({ agentSlug, toolPool = [], defaultAgentTools = null } = {}) {
  const slug = String(agentSlug || '').trim();
  const poolNames = new Set(
    (toolPool || [])
      .map((tool) => String(tool?.name || '').trim())
      .filter((name) => name && name !== 'search_tools'),
  );
  const catalog = listAgentToolCatalog().filter((tool) => {
    if (!poolNames.has(tool.name)) return false;
    if (slug && !toolBelongsToAgent(tool.name, slug)) return false;
    if (slug && isDefaultToolForAgent(tool.name, slug, defaultAgentTools)) return false;
    return true;
  });
  return catalog.map((tool) => {
    const live = (toolPool || []).find((item) => item.name === tool.name);
    return {
      name: tool.name,
      title: tool.title,
      description: String(live?.description || tool.description || '').trim(),
    };
  });
}

function searchDeferredTools({
  query,
  limit = DEFAULT_SEARCH_LIMIT,
  agentSlug,
  toolPool,
  defaultAgentTools = null,
} = {}) {
  const raw = String(query || '').trim();
  if (!raw) {
    return { ok: false, error: 'empty_query', tools: [] };
  }
  const tokens = tokenizeQuery(raw);
  if (!tokens.length) {
    return { ok: false, error: 'empty_query', tools: [] };
  }
  const capped = Math.min(
    MAX_SEARCH_LIMIT,
    Math.max(1, Number(limit) || DEFAULT_SEARCH_LIMIT),
  );
  const ranked = searchableToolMeta({ agentSlug, toolPool, defaultAgentTools })
    .map((tool) => ({ tool, score: scoreToolMatch(tool, tokens, raw) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, capped)
    .map((row) => row.tool);

  return {
    ok: true,
    query: raw,
    activated: ranked.map((tool) => tool.name),
    tools: ranked,
  };
}

function createSearchToolsTool({ agentSlug, getToolPool, defaultAgentTools = null } = {}) {
  return {
    name: 'search_tools',
    description: factoryToolDescription('search_tools'),
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Short keywords describing the capability you need (2–6 terms).',
        },
        limit: {
          type: 'integer',
          description: `Max tools to return (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).`,
        },
      },
      required: ['query'],
    },
    execute: async ({ query, limit } = {}) => {
      const toolPool = typeof getToolPool === 'function' ? getToolPool() : [];
      return searchDeferredTools({ query, limit, agentSlug, toolPool, defaultAgentTools });
    },
  };
}

module.exports = {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  tokenizeQuery,
  scoreToolMatch,
  searchableToolMeta,
  searchDeferredTools,
  createSearchToolsTool,
};
