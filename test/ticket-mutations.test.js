const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  RegosCrmError,
  searchClients,
  getClientById,
  editClient,
  createTicket,
  editTicket,
  setTicketStatus,
  setTicketResponsible,
} = require('../src/integrations/regos-crm');

describe('REGOS ticket mutations', () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.REGOS_INTEGRATION_TOKEN;
  const originalTarget = process.env.REGOS_API_TARGET;
  let calls;
  let responses;

  before(() => {
    process.env.REGOS_INTEGRATION_TOKEN = 'test-token';
    process.env.REGOS_API_TARGET = 'https://regos.test';
  });

  after(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.REGOS_INTEGRATION_TOKEN;
    else process.env.REGOS_INTEGRATION_TOKEN = originalToken;
    if (originalTarget === undefined) delete process.env.REGOS_API_TARGET;
    else process.env.REGOS_API_TARGET = originalTarget;
  });

  beforeEach(() => {
    calls = [];
    responses = [];
    global.fetch = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      const data = responses.shift() || { ok: true, result: {} };
      return {
        ok: true,
        status: 200,
        json: async () => data,
      };
    };
  });

  it('creates a ticket with only documented fields and returns new_id', async () => {
    responses.push({ ok: true, result: { new_id: 610 } });

    const created = await createTicket({
      client_id: '501',
      channel_id: 22,
      direction: 'Outbound',
      subject: ' Delivery question ',
      description: ' Details ',
      responsible_user_id: 31,
      status: 'Open',
      ignored: 'value',
    });

    assert.equal(created.id, 610);
    assert.equal(calls[0].url, 'https://regos.test/gateway/out/test-token/v1/Ticket/Add');
    assert.deepEqual(calls[0].body, {
      client_id: 501,
      channel_id: 22,
      direction: 'Outbound',
      subject: 'Delivery question',
      description: 'Details',
      responsible_user_id: 31,
    });
  });

  it('dispatches scalar, status, and responsible updates to dedicated methods', async () => {
    responses.push(
      { ok: true, result: { row_affected: 1, ids: [610] } },
      { ok: true, result: { row_affected: 1, ids: [610] } },
      { ok: true, result: { row_affected: 1, ids: [610] } }
    );

    await editTicket(610, {
      subject: 'Updated',
      description: '',
      direction: 'Inbound',
    });
    await setTicketResponsible(610, 31);
    await setTicketStatus(610, 'WaitingClient');

    assert.deepEqual(
      calls.map((call) => call.url.split('/v1/')[1]),
      ['Ticket/Edit', 'Ticket/SetResponsible', 'Ticket/SetStatus']
    );
    assert.deepEqual(calls[0].body, {
      id: 610,
      subject: 'Updated',
      description: '',
      direction: 'Inbound',
    });
  });

  it('does not call REGOS for an empty scalar edit', async () => {
    assert.deepEqual(await editTicket(610, {}), { changed: false, result: null });
    assert.equal(calls.length, 0);
  });

  it('searches clients with bounded pagination', async () => {
    responses.push({
      ok: true,
      result: [{ id: 125, name: 'Ivan Petrov' }],
      total: 1,
      next_offset: 0,
    });
    const clients = await searchClients('Petrov', { limit: 999 });
    assert.equal(clients[0].id, 125);
    assert.deepEqual(calls[0].body, { limit: 50, offset: 0, search: 'Petrov' });
  });

  it('loads and edits a CRM client without responsible_user_id', async () => {
    responses.push(
      {
        ok: true,
        result: [{ id: 126, name: 'Maria', phone: '99890', email: 'a@b.c' }],
        total: 1,
        next_offset: 0,
      },
      { ok: true, result: { row_affected: 1, ids: [126] } }
    );

    const client = await getClientById(126);
    assert.equal(client.name, 'Maria');
    assert.deepEqual(calls[0].body, { ids: [126], limit: 1, offset: 0 });

    const edited = await editClient(126, {
      name: ' Maria Sokolova ',
      phone: '+998933334400',
      email: 'maria@example.com',
      description: 'VIP',
      external_id: 'ext-1',
      responsible_user_id: 99,
    });
    assert.equal(edited.changed, true);
    assert.equal(calls[1].url.split('/v1/')[1], 'Client/Edit');
    assert.deepEqual(calls[1].body, {
      id: 126,
      name: 'Maria Sokolova',
      phone: '+998933334400',
      email: 'maria@example.com',
      description: 'VIP',
      external_id: 'ext-1',
    });
  });

  it('rejects invalid input before making a remote request', async () => {
    await assert.rejects(
      () => createTicket({ client_id: 0, channel_id: 22 }),
      (error) => error instanceof RegosCrmError && error.status === 400
    );
    await assert.rejects(
      () => editTicket(610, { subject: 'x'.repeat(301) }),
      (error) => error instanceof RegosCrmError && error.status === 400
    );
    await assert.rejects(
      () => setTicketStatus(610, 'Default'),
      (error) => error instanceof RegosCrmError && error.status === 400
    );
    assert.equal(calls.length, 0);
  });

  it('preserves REGOS business errors', async () => {
    responses.push({
      ok: false,
      result: { error: 'PermissionDenied', description: 'Not allowed' },
    });
    await assert.rejects(
      () => setTicketStatus(610, 'Closed'),
      (error) =>
        error instanceof RegosCrmError &&
        error.status === 502 &&
        /PermissionDenied/.test(error.message)
    );
  });
});
