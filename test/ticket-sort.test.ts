import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTicketSortOrder } from '../src/admin/bot-admin-routes-tickets';

describe('parseTicketSortOrder', () => {
  it('defaults to last_update DESC when sort is missing', () => {
    assert.deepEqual(parseTicketSortOrder(undefined), { column: 'last_update', direction: 'DESC' });
    assert.deepEqual(parseTicketSortOrder(''), { column: 'last_update', direction: 'DESC' });
  });

  it('accepts a whitelisted column and direction', () => {
    assert.deepEqual(parseTicketSortOrder('client.name:asc'), { column: 'client.name', direction: 'ASC' });
    assert.deepEqual(parseTicketSortOrder('rating:DESC'), { column: 'rating', direction: 'DESC' });
  });

  it('falls back when the column or direction is not allowed', () => {
    assert.deepEqual(parseTicketSortOrder('subject:asc'), { column: 'last_update', direction: 'DESC' });
    assert.deepEqual(parseTicketSortOrder('id:sideways'), { column: 'last_update', direction: 'DESC' });
    assert.deepEqual(parseTicketSortOrder('id'), { column: 'last_update', direction: 'DESC' });
  });
});
