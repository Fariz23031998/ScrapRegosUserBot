const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  listToolSchemas,
  runAgentToolTest,
  toolRequiresTicket,
} = require('../src/ai/tools/test-runner');

describe('ai tool test-runner', () => {
  it('marks ticket-scoped tools', () => {
    assert.equal(toolRequiresTicket('search_chat_history'), true);
    assert.equal(toolRequiresTicket('close_ticket'), true);
    assert.equal(toolRequiresTicket('web_search'), false);
  });

  it('lists known tool schemas with parameters', () => {
    const tools = listToolSchemas({ db: null });
    assert.ok(tools.length >= 10);
    const search = tools.find((tool) => tool.name === 'search_knowledge');
    assert.ok(search);
    assert.equal(search.requires_ticket, false);
    assert.equal(search.parameters?.type, 'object');
    const history = tools.find((tool) => tool.name === 'search_chat_history');
    assert.equal(history?.requires_ticket, true);
    const reply = tools.find((tool) => tool.name === 'reply_to_customer');
    assert.ok(reply);
    assert.equal(reply.requires_ticket, true);
    const close = tools.find((tool) => tool.name === 'close_ticket');
    assert.ok(close);
    assert.equal(close.requires_ticket, true);
  });

  it('rejects unknown tools', async () => {
    const result = await runAgentToolTest({
      db: null,
      toolName: 'not_a_real_tool',
      args: {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'unknown_tool');
  });

  it('requires ticket id for ticket-scoped tools', async () => {
    const result = await runAgentToolTest({
      db: null,
      toolName: 'assign_responsible',
      args: { regos_user_id: 1 },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'ticket_required');
  });

  it('returns not found for missing tickets', async () => {
    const result = await runAgentToolTest({
      db: null,
      toolName: 'assign_responsible',
      args: { regos_user_id: 1 },
      ticketId: 999001,
      deps: {
        findTicketById: async () => null,
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'ticket_not_found');
  });

  it('executes a tool with injected deps', async () => {
    let calledWith = null;
    const result = await runAgentToolTest({
      db: null,
      toolName: 'list_group_topics',
      args: {},
      deps: {
        listGroupTopics: () => {
          calledWith = true;
          return [{ key: 'ops', name: 'Ops' }];
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.tool, 'list_group_topics');
    assert.equal(calledWith, true);
    assert.deepEqual(result.result, [{ key: 'ops', name: 'Ops' }]);
    assert.ok(Number.isFinite(result.duration_ms));
  });

  it('executes ticket tool when ticket context is provided', async () => {
    const result = await runAgentToolTest({
      db: null,
      toolName: 'assign_responsible',
      args: { regos_user_id: 42 },
      ticketId: 15,
      deps: {
        findTicketById: async (id) => ({ id: Number(id), chat_id: 'chat-15' }),
        setTicketResponsible: async (ticketId, userId) => {
          assert.equal(ticketId, 15);
          assert.equal(userId, 42);
        },
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, { ok: true, responsible_user_id: 42 });
  });
});
