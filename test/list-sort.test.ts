import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveListOrderBy, staffNameSql } from '../src/db/list-sort';

const columns = {
  name: 'd.name COLLATE NOCASE',
  amount: 'd.cost_amount',
};

describe('resolveListOrderBy', () => {
  it('returns null when sort is missing or not allowed', () => {
    assert.equal(resolveListOrderBy(undefined, columns, 'd.id'), null);
    assert.equal(resolveListOrderBy('', columns, 'd.id'), null);
    assert.equal(resolveListOrderBy('subject:asc', columns, 'd.id'), null);
    assert.equal(resolveListOrderBy('name:sideways', columns, 'd.id'), null);
    assert.equal(resolveListOrderBy('name', columns, 'd.id'), null);
    assert.equal(resolveListOrderBy("name;drop:asc", columns, 'd.id'), null);
  });

  it('builds an ORDER BY from the whitelist only', () => {
    assert.equal(
      resolveListOrderBy('name:asc', columns, 'd.id'),
      'ORDER BY d.name COLLATE NOCASE ASC, d.id ASC',
    );
    assert.equal(
      resolveListOrderBy('amount:DESC', columns, 'd.id'),
      'ORDER BY d.cost_amount DESC, d.id DESC',
    );
  });

  it('does not copy the request text into the clause', () => {
    const clause = resolveListOrderBy("name' OR 1=1:asc", columns, 'd.id');
    assert.equal(clause, null);
  });
});

describe('staffNameSql', () => {
  it('uses only the alias', () => {
    assert.match(staffNameSql('tech'), /tech\.display_name/);
    assert.throws(() => staffNameSql('tech;drop'));
  });
});
