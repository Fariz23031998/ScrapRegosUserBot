const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDb } = require('../src/db/partners-db');
const { setSetting } = require('../src/db/app-settings');
const {
  filterEnabledTools,
  expandDisabledToolsToAgentMap,
  deriveFullyDisabledTools,
  emptyDisabledAgentTools,
} = require('../src/ai/tools/catalog');
const {
  loadAiSettings,
  saveAiSettings,
  serializeAiSettings,
  normalizeDisabledAgentTools,
  resolveDisabledAgentTools,
} = require('../src/ai/settings');

const SAMPLE_TOOLS = [
  { name: 'search_knowledge' },
  { name: 'notify_employee' },
  { name: 'create_article' },
  { name: 'reply_to_customer' },
];

let db = null;
let dbPath = null;

function removeDbFiles(filePath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${filePath}${suffix}`);
    } catch {
      // Ignore missing temporary files.
    }
  }
}

function createDb() {
  dbPath = path.join(
    os.tmpdir(),
    `scrapregos-disabled-tools-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
  db = openDb(dbPath);
  return db;
}

afterEach(() => {
  db?.close();
  db = null;
  if (dbPath) removeDbFiles(dbPath);
  dbPath = null;
});

describe('filterEnabledTools', () => {
  it('filters a per-agent denylist by slug', () => {
    const disabled = {
      customer: ['notify_employee'],
      customer_assist: [],
      kb: ['search_knowledge'],
    };
    const customer = filterEnabledTools(SAMPLE_TOOLS, disabled, 'customer').map((tool) => tool.name);
    const assist = filterEnabledTools(SAMPLE_TOOLS, disabled, 'customer_assist').map((tool) => tool.name);
    const kb = filterEnabledTools(SAMPLE_TOOLS, disabled, 'kb').map((tool) => tool.name);
    assert.deepEqual(customer, ['search_knowledge', 'create_article', 'reply_to_customer']);
    assert.deepEqual(assist, ['search_knowledge', 'notify_employee', 'create_article', 'reply_to_customer']);
    assert.deepEqual(kb, ['notify_employee', 'create_article', 'reply_to_customer']);
  });

  it('treats a legacy string array as disabled for every agent', () => {
    const names = filterEnabledTools(SAMPLE_TOOLS, ['notify_employee'], 'kb').map((tool) => tool.name);
    assert.deepEqual(names, ['search_knowledge', 'create_article', 'reply_to_customer']);
  });

  it('returns all tools when the denylist is empty', () => {
    assert.equal(filterEnabledTools(SAMPLE_TOOLS, emptyDisabledAgentTools(), 'customer').length, SAMPLE_TOOLS.length);
    assert.equal(filterEnabledTools(SAMPLE_TOOLS, [], 'customer').length, SAMPLE_TOOLS.length);
  });
});

describe('disabled agent tools migration', () => {
  it('expands a global list onto every catalog agent for that tool', () => {
    const map = expandDisabledToolsToAgentMap(['search_knowledge', 'reply_to_customer']);
    assert.deepEqual(map.customer, ['search_knowledge']);
    assert.deepEqual(map.customer_assist, ['search_knowledge', 'reply_to_customer']);
    assert.deepEqual(map.kb, ['search_knowledge']);
    assert.deepEqual(map.ops, []);
  });

  it('derives fully disabled names from a per-agent map', () => {
    assert.deepEqual(
      deriveFullyDisabledTools({
        customer: ['search_knowledge', 'notify_employee'],
        customer_assist: ['search_knowledge'],
        kb: ['search_knowledge'],
      }),
      ['search_knowledge'],
    );
  });

  it('migrates a legacy array when the per-agent map is empty', () => {
    const resolved = resolveDisabledAgentTools(emptyDisabledAgentTools(), ['notify_employee']);
    assert.deepEqual(resolved.customer, ['notify_employee']);
    assert.deepEqual(resolved.customer_assist, ['notify_employee']);
    assert.deepEqual(resolved.kb, []);
  });

  it('keeps an existing per-agent map instead of expanding the legacy array', () => {
    const resolved = resolveDisabledAgentTools(
      { customer: ['web_search'], customer_assist: [], kb: [] },
      ['notify_employee'],
    );
    assert.deepEqual(resolved.customer, ['web_search']);
    assert.deepEqual(resolved.customer_assist, []);
    assert.deepEqual(resolved.kb, []);
  });

  it('rejects a tool that does not belong to the agent', () => {
    assert.throws(
      () => normalizeDisabledAgentTools({ customer: ['reply_to_customer'] }),
      /INVALID_AI_DISABLED_TOOLS/,
    );
  });

  it('accepts a legacy array through normalizeDisabledAgentTools', () => {
    const map = normalizeDisabledAgentTools(['create_article']);
    assert.deepEqual(map.kb, ['create_article']);
    assert.deepEqual(map.customer, []);
  });
});

describe('ai settings disabled agent tools', () => {
  it('loads a legacy ai_disabled_tools array as a per-agent map', () => {
    const database = createDb();
    setSetting(database, 'ai_disabled_tools', JSON.stringify(['notify_employee', 'create_article']));
    const settings = loadAiSettings(database);
    assert.deepEqual(settings.disabledAgentTools.customer, ['notify_employee']);
    assert.deepEqual(settings.disabledAgentTools.customer_assist, ['notify_employee']);
    assert.deepEqual(settings.disabledAgentTools.kb, ['create_article']);
    assert.deepEqual(settings.disabledTools, ['create_article', 'notify_employee']);

    const serialized = serializeAiSettings(settings);
    const knowledge = serialized.agent_tools.find((tool) => tool.name === 'search_knowledge');
    const notify = serialized.agent_tools.find((tool) => tool.name === 'notify_employee');
    const create = serialized.agent_tools.find((tool) => tool.name === 'create_article');
    assert.equal(knowledge.enabled, true);
    assert.deepEqual(knowledge.enabled_agents, {
      customer: true,
      customer_assist: true,
      kb: true,
    });
    assert.equal(notify.enabled, false);
    assert.equal(notify.enabled_agents.customer, false);
    assert.equal(notify.enabled_agents.customer_assist, false);
    assert.equal(create.enabled, false);
    assert.equal(create.enabled_agents.kb, false);
    assert.deepEqual(serialized.disabled_tools, ['create_article', 'notify_employee']);
  });

  it('saves a mixed per-agent map and derives fully disabled tools', () => {
    const database = createDb();
    const saved = saveAiSettings(database, {
      disabledAgentTools: {
        customer: ['search_knowledge'],
        customer_assist: [],
        kb: ['search_knowledge'],
      },
    });
    assert.deepEqual(saved.disabledAgentTools.customer, ['search_knowledge']);
    assert.deepEqual(saved.disabledAgentTools.customer_assist, []);
    assert.deepEqual(saved.disabledAgentTools.kb, ['search_knowledge']);
    assert.deepEqual(saved.disabledTools, []);

    const serialized = serializeAiSettings(saved);
    const knowledge = serialized.agent_tools.find((tool) => tool.name === 'search_knowledge');
    assert.equal(knowledge.enabled, false);
    assert.equal(knowledge.enabled_agents.customer, false);
    assert.equal(knowledge.enabled_agents.customer_assist, true);
    assert.equal(knowledge.enabled_agents.kb, false);
    assert.deepEqual(serialized.disabled_tools, []);
    assert.deepEqual(serialized.disabled_agent_tools.customer, ['search_knowledge']);
  });

  it('expands a legacy disabled_tools patch when the map is omitted', () => {
    const database = createDb();
    const saved = saveAiSettings(database, { disabledTools: ['reply_to_customer'] });
    assert.deepEqual(saved.disabledAgentTools.customer_assist, ['reply_to_customer']);
    assert.deepEqual(saved.disabledAgentTools.customer, []);
    assert.deepEqual(saved.disabledTools, ['reply_to_customer']);
  });
});
