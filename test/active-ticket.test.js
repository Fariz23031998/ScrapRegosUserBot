const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveActiveTicket,
  mapActiveTicket,
} = require('../src/integrations/regos-crm');

describe('resolveActiveTicket', () => {
  it('returns the ticket when status is Open', () => {
    const ticket = {
      id: 10,
      subject: 'Help',
      status: 'Open',
      client: { name: 'Ada', phone: '+998901111111' },
      created_date: 1700000000,
      responsible_user_id: 5,
    };
    assert.equal(resolveActiveTicket(ticket), ticket);
  });

  it('returns the ticket when status is WaitingStaff', () => {
    const ticket = {
      id: 11,
      subject: 'Need reply',
      status: 'WaitingStaff',
      client: { name: 'Bob', phone: '+998902222222' },
      created_date: 1700001000,
      responsible_user_id: 5,
    };
    assert.equal(resolveActiveTicket(ticket), ticket);
  });

  it('returns null for Closed and WaitingClient latest tickets', () => {
    for (const status of ['Closed', 'WaitingClient']) {
      assert.equal(
        resolveActiveTicket({ id: 1, status, subject: 'x' }),
        null,
        `expected null for status ${status}`
      );
    }
  });

  it('returns null when ticket is missing', () => {
    assert.equal(resolveActiveTicket(null), null);
    assert.equal(resolveActiveTicket(undefined), null);
  });
});

describe('mapActiveTicket', () => {
  it('maps the active ticket payload fields', () => {
    assert.deepEqual(
      mapActiveTicket({
        id: 42,
        subject: 'Тема',
        status: 'Open',
        client: { name: 'Client', phone: '90111' },
        created_date: 1710000000,
        responsible_user_id: 7,
        description: 'ignored in map',
      }),
      {
        id: 42,
        subject: 'Тема',
        status: 'Open',
        client: { name: 'Client', phone: '90111' },
        created_date: 1710000000,
        responsible_user_id: 7,
      }
    );
  });

  it('returns null for empty input', () => {
    assert.equal(mapActiveTicket(null), null);
  });

  it('keeps unpaid orders and technical support in local payload', () => {
    assert.deepEqual(
      mapActiveTicket({
        id: 43,
        subject: 'Call',
        status: 'Open',
        client: { name: 'Client', phone: '90111' },
        created_date: 1710000000,
        responsible_user_id: 7,
        local: {
          unpaid_orders: { count: 2, total_amount: 150000, orders: [{ id: 'a' }] },
          technical_support: {
            status: 'active',
            ends_at: '2026-09-01T00:00:00.000Z',
            starts_at: '2026-08-01T00:00:00.000Z',
          },
          firms: [{ id: 1, firm_type: 'partner', firm_record_id: '9' }],
          recording: { url: 'http://example/x.wav', duration_seconds: 12 },
        },
      }),
      {
        id: 43,
        subject: 'Call',
        status: 'Open',
        client: { name: 'Client', phone: '90111' },
        created_date: 1710000000,
        responsible_user_id: 7,
        local: {
          unpaid_orders: { count: 2, total_amount: 150000, orders: [{ id: 'a' }] },
          technical_support: {
            status: 'active',
            ends_at: '2026-09-01T00:00:00.000Z',
            starts_at: '2026-08-01T00:00:00.000Z',
          },
          firms: [{ id: 1, firm_type: 'partner', firm_record_id: '9' }],
        },
      }
    );
  });
});
