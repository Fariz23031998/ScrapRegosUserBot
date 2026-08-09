const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeQuery,
  cacheKey,
  getTtlSec,
  DEFAULT_TTL_BALANCE_SEC,
  DEFAULT_TTL_SEC,
  cachedSearch,
} = require('../src/live/portal-cache');

describe('portal-cache helpers', () => {
  const prev = {};

  beforeEach(() => {
    for (const key of [
      'REDIS_URL',
      'PORTAL_CACHE_ENABLED',
      'PORTAL_CACHE_TTL_BALANCE_SEC',
      'PORTAL_CACHE_TTL_SEC',
    ]) {
      prev[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('normalizes phone-like queries to digits', () => {
    assert.equal(normalizeQuery('+998 90 123-45-67'), '998901234567');
    assert.equal(normalizeQuery('  301234567  '), '301234567');
  });

  it('normalizes text queries with trim and lowercase', () => {
    assert.equal(normalizeQuery('  Foo   Bar  '), 'foo bar');
  });

  it('builds stable cache keys', () => {
    assert.equal(
      cacheKey('partners', '998901234567'),
      'portal:search:partners:998901234567'
    );
  });

  it('uses balance TTL for partner kinds and default TTL otherwise', () => {
    delete process.env.PORTAL_CACHE_TTL_BALANCE_SEC;
    delete process.env.PORTAL_CACHE_TTL_SEC;
    assert.equal(getTtlSec('partners'), DEFAULT_TTL_BALANCE_SEC);
    assert.equal(getTtlSec('vcr1_partners'), DEFAULT_TTL_BALANCE_SEC);
    assert.equal(getTtlSec('licenses'), DEFAULT_TTL_SEC);
    assert.equal(getTtlSec('rpos_clients'), DEFAULT_TTL_SEC);
  });

  it('honors env TTL overrides', () => {
    process.env.PORTAL_CACHE_TTL_BALANCE_SEC = '30';
    process.env.PORTAL_CACHE_TTL_SEC = '90';
    assert.equal(getTtlSec('partners'), 30);
    assert.equal(getTtlSec('licenses'), 90);
  });

  it('fail-opens when Redis is not configured', async () => {
    delete process.env.REDIS_URL;
    let calls = 0;
    const rows = await cachedSearch('partners', '998901234567', async () => {
      calls += 1;
      return [{ id: 1 }];
    });
    assert.deepEqual(rows, [{ id: 1 }]);
    assert.equal(calls, 1);
  });

  it('skips cache when PORTAL_CACHE_ENABLED=0 even if REDIS_URL is set', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    process.env.PORTAL_CACHE_ENABLED = '0';
    let calls = 0;
    await cachedSearch('partners', '998901234567', async () => {
      calls += 1;
      return [];
    });
    assert.equal(calls, 1);
  });
});
