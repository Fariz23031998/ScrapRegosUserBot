const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  defaultToolNamesForAgent,
  isDefaultToolForAgent,
  selectDefaultTools,
  prepareAgentTools,
} = require('../src/ai/tools/catalog');
const {
  searchDeferredTools,
  createSearchToolsTool,
} = require('../src/ai/tools/search-tools');
const {
  runAgent,
  activateToolsFromSearchResult,
  mergeToolsByName,
} = require('../src/ai/run-agent');

describe('default agent tools', () => {
  it('lists curated defaults per agent', () => {
    assert.deepEqual(defaultToolNamesForAgent('customer').sort(), [
      'get_article',
      'search_chat_history',
      'search_knowledge',
      'search_tools',
    ]);
    assert.ok(defaultToolNamesForAgent('customer_assist').includes('reply_to_customer'));
    assert.deepEqual(defaultToolNamesForAgent('kb').sort(), [
      'get_article',
      'list_knowledge_categories',
      'search_knowledge',
      'search_tools',
    ]);
    assert.deepEqual(defaultToolNamesForAgent('ops').sort(), [
      'search_devices',
      'search_services',
      'search_tasks',
      'search_tools',
    ]);
  });

  it('selectDefaultTools keeps only defaults from a pool', () => {
    const pool = [
      { name: 'search_tools' },
      { name: 'search_knowledge' },
      { name: 'notify_employee' },
      { name: 'get_article' },
    ];
    assert.deepEqual(
      selectDefaultTools(pool, 'customer').map((tool) => tool.name).sort(),
      ['get_article', 'search_knowledge', 'search_tools'],
    );
    assert.equal(isDefaultToolForAgent('notify_employee', 'customer'), false);
  });
});

describe('search_tools', () => {
  const pool = [
    {
      name: 'notify_employee',
      description: 'Send a Telegram message to an employee',
    },
    {
      name: 'search_orders',
      description: 'Search local payment orders by phone',
    },
    {
      name: 'get_prices',
      description: 'Load the service price catalog',
    },
    {
      name: 'search_knowledge',
      description: 'Search knowledge base',
    },
  ];

  it('matches deferred tools by keywords and skips defaults', () => {
    const result = searchDeferredTools({
      query: 'telegram notify employee',
      agentSlug: 'customer',
      toolPool: pool,
    });
    assert.equal(result.ok, true);
    assert.ok(result.tools.some((tool) => tool.name === 'notify_employee'));
    assert.ok(!result.tools.some((tool) => tool.name === 'search_knowledge'));
    assert.deepEqual(result.activated, result.tools.map((tool) => tool.name));
  });

  it('excludes disabled-missing tools that are not in the pool', () => {
    const result = searchDeferredTools({
      query: 'orders payment',
      agentSlug: 'customer',
      toolPool: pool.filter((tool) => tool.name !== 'search_orders'),
    });
    assert.ok(!result.tools.some((tool) => tool.name === 'search_orders'));
  });

  it('createSearchToolsTool executes against the live pool', async () => {
    const tool = createSearchToolsTool({
      agentSlug: 'customer',
      getToolPool: () => pool,
    });
    const result = await tool.execute({ query: 'price catalog' });
    assert.equal(result.ok, true);
    assert.ok(result.tools.some((row) => row.name === 'get_prices'));
  });
});

describe('prepareAgentTools deferred split', () => {
  const factoryTools = [
    { name: 'search_knowledge', description: 'kb', execute: async () => ({}) },
    { name: 'get_article', description: 'article', execute: async () => ({}) },
    { name: 'notify_employee', description: 'notify', execute: async () => ({}) },
    { name: 'search_chat_history', description: 'chat', execute: async () => ({}) },
    { name: 'get_prices', description: 'prices', execute: async () => ({}) },
  ];

  it('returns active defaults and a larger tool pool including search_tools', () => {
    const prepared = prepareAgentTools(factoryTools, {
      settings: { disabledAgentTools: { customer: [], customer_assist: [], kb: [], ops: [] } },
      agentSlug: 'customer',
    });
    const activeNames = prepared.activeTools.map((tool) => tool.name).sort();
    const poolNames = prepared.toolPool.map((tool) => tool.name).sort();
    assert.deepEqual(activeNames, [
      'get_article',
      'search_chat_history',
      'search_knowledge',
      'search_tools',
    ]);
    assert.ok(poolNames.includes('notify_employee'));
    assert.ok(poolNames.includes('search_tools'));
    assert.ok(prepared.activeTools.every((tool) => typeof tool.execute === 'function'));
  });

  it('drops a disabled default tool from activeTools and toolPool for that agent only', () => {
    const customer = prepareAgentTools(factoryTools, {
      settings: {
        disabledAgentTools: {
          customer: ['search_knowledge'],
          customer_assist: [],
          kb: [],
          ops: [],
        },
      },
      agentSlug: 'customer',
    });
    assert.ok(!customer.activeTools.some((tool) => tool.name === 'search_knowledge'));
    assert.ok(!customer.toolPool.some((tool) => tool.name === 'search_knowledge'));
    assert.ok(customer.activeTools.some((tool) => tool.name === 'get_article'));

    const kb = prepareAgentTools(factoryTools, {
      settings: {
        disabledAgentTools: {
          customer: ['search_knowledge'],
          customer_assist: [],
          kb: [],
          ops: [],
        },
      },
      agentSlug: 'kb',
    });
    assert.ok(kb.activeTools.some((tool) => tool.name === 'search_knowledge'));
    assert.ok(kb.toolPool.some((tool) => tool.name === 'search_knowledge'));
  });

  it('keeps disabled deferred tools out of search_tools results', async () => {
    const prepared = prepareAgentTools(factoryTools, {
      settings: {
        disabledAgentTools: {
          customer: ['notify_employee', 'get_prices'],
          customer_assist: [],
          kb: [],
          ops: [],
        },
      },
      agentSlug: 'customer',
    });
    assert.ok(!prepared.toolPool.some((tool) => tool.name === 'notify_employee'));
    const search = prepared.toolPool.find((tool) => tool.name === 'search_tools');
    assert.ok(search);
    const found = await search.execute({ query: 'notify employee telegram prices' });
    assert.equal(found.ok, true);
    assert.ok(!found.tools.some((tool) => tool.name === 'notify_employee'));
    assert.ok(!found.tools.some((tool) => tool.name === 'get_prices'));
  });

  it('omits search_tools entirely when disabled for the agent', () => {
    const prepared = prepareAgentTools(factoryTools, {
      settings: {
        disabledAgentTools: {
          customer: ['search_tools'],
          customer_assist: [],
          kb: [],
          ops: [],
        },
      },
      agentSlug: 'customer',
    });
    assert.ok(!prepared.activeTools.some((tool) => tool.name === 'search_tools'));
    assert.ok(!prepared.toolPool.some((tool) => tool.name === 'search_tools'));
  });

  it('honours custom defaultAgentTools from settings', () => {
    const prepared = prepareAgentTools(factoryTools, {
      settings: {
        disabledAgentTools: { customer: [], customer_assist: [], kb: [], ops: [] },
        defaultAgentTools: {
          customer: ['notify_employee', 'search_tools'],
          customer_assist: [],
          kb: [],
          ops: [],
        },
      },
      agentSlug: 'customer',
    });
    assert.deepEqual(
      prepared.activeTools.map((tool) => tool.name).sort(),
      ['notify_employee', 'search_tools'],
    );
    assert.ok(prepared.toolPool.some((tool) => tool.name === 'search_knowledge'));
    assert.ok(!prepared.activeTools.some((tool) => tool.name === 'search_knowledge'));
  });
});

describe('runAgent tool activation', () => {
  it('merges activated tools from search_tools results', () => {
    const active = [{ name: 'search_tools' }, { name: 'search_knowledge' }];
    const pool = [
      ...active,
      { name: 'notify_employee', execute: async () => ({ ok: true }) },
    ];
    const next = activateToolsFromSearchResult(
      active,
      pool,
      JSON.stringify({ ok: true, activated: ['notify_employee'], tools: [{ name: 'notify_employee' }] }),
    );
    assert.deepEqual(
      mergeToolsByName(active, []).map((tool) => tool.name).sort(),
      ['search_knowledge', 'search_tools'],
    );
    assert.ok(next.some((tool) => tool.name === 'notify_employee'));
  });

  it('activates deferred tools after search_tools and rejects premature calls', async () => {
    let step = 0;
    const deferred = {
      name: 'notify_employee',
      description: 'notify',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ ok: true, notified: true }),
    };
    let pool = [];
    const search = createSearchToolsTool({
      agentSlug: 'customer',
      getToolPool: () => pool,
    });
    pool = [search, deferred];
    const provider = {
      chat: async ({ tools }) => {
        step += 1;
        if (step === 1) {
          return {
            content: null,
            toolCalls: [
              {
                id: 'c1',
                name: 'notify_employee',
                arguments: '{}',
              },
            ],
            usage: null,
          };
        }
        if (step === 2) {
          assert.ok(!tools.some((tool) => tool.name === 'notify_employee'));
          return {
            content: null,
            toolCalls: [
              {
                id: 'c2',
                name: 'search_tools',
                arguments: JSON.stringify({ query: 'notify employee telegram' }),
              },
            ],
            usage: null,
          };
        }
        if (step === 3) {
          assert.ok(tools.some((tool) => tool.name === 'notify_employee'));
          return {
            content: null,
            toolCalls: [
              {
                id: 'c3',
                name: 'notify_employee',
                arguments: '{}',
              },
            ],
            usage: null,
          };
        }
        return { content: 'done', toolCalls: [], usage: null };
      },
    };

    const result = await runAgent({
      provider,
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [search],
      toolPool: pool,
      maxSteps: 6,
    });

    const errors = result.trace
      .flatMap((row) => row.tool_calls || [])
      .map((call) => call.error)
      .filter(Boolean);
    assert.ok(errors.some((error) => String(error).includes('tool_not_active:notify_employee')));
    const notifyOk = result.trace
      .flatMap((row) => row.tool_calls || [])
      .find((call) => call.name === 'notify_employee' && call.ok);
    assert.ok(notifyOk);
    assert.equal(result.content, 'done');
  });
});
