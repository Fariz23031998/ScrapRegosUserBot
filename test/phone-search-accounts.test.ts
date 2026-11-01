import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

function replaceModuleExports(specifier: string, overrides: Record<string, unknown>) {
  const id = require.resolve(specifier);
  const current = require(id);
  const next: Record<string, any> = {};
  for (const key of Object.keys(current)) next[key] = current[key];
  Object.assign(next, overrides);
  const cached = require.cache[id];
  const previous = cached?.exports;
  if (cached) cached.exports = next;
  return {
    restore() {
      if (cached) cached.exports = previous;
    },
  };
}

describe('phone search related accounts', () => {
  const portalId = require.resolve('../src/live/portal-search');
  const searchId = require.resolve('../src/bot/search-user');
  let restore = () => {};
  let searchUser: (query: string, db?: any) => Promise<any>;
  let listed: any[] = [];
  let accountsForPartner: any[] = [];
  let accountsError: Error | null = null;

  const partner = {
    id: 5220,
    name: 'Anvar Suvankulov',
    phone: '998901112233',
    registered_at: '01.11.2026 14:31:02',
    _account: 'SAMARKAND',
  };

  const account = {
    id: 2424,
    api_login: 'DB260486-B0BRX2',
    status: 'Активен',
    api_server: 'APIUZB0003',
    tariff: 'Basic',
    paid_until: '01.12.2026 23:59:59',
    dealer_create: 'ООО ROFEEV',
    date_create: '01.11.2026 14:31:02',
    _account: 'SAMARKAND',
  };

  before(() => {
    listed = [];
    accountsForPartner = [account];
    accountsError = null;
    restore = replaceModuleExports(portalId, {
      liveSearchPartners: async () => [partner],
      liveSearchVcr1Partners: async () => [],
      liveSearchLicenses: async () => [],
      liveSearchRposClients: async () => [],
      liveListPartnerAccounts: async (partnerId: any, accountLabel: any) => {
        listed.push([partnerId, accountLabel]);
        if (accountsError) throw accountsError;
        return accountsForPartner;
      },
    }).restore;
    delete require.cache[searchId];
    searchUser = require(searchId).searchUser;
  });

  after(() => {
    restore();
    delete require.cache[searchId];
  });

  it('includes accounts loaded for the matched partner', async () => {
    listed = [];
    accountsForPartner = [account];
    accountsError = null;
    const result = await searchUser('998901112233', null as any);
    assert.equal(result.found, true);
    assert.deepEqual(listed, [[5220, 'SAMARKAND']]);
    const card = result.results[0];
    assert.equal(card.accountId, 2424);
    assert.equal(card.accountLabel, 'SAMARKAND');
    assert.equal(card.apiLogin, 'DB260486-B0BRX2');
    assert.equal(card.tariff, 'Basic');
    assert.match(card.message, /REGOS \(Samarkand\)/);
    assert.match(card.message, /Аккаунт:<\/b> DB260486-B0BRX2/);
    assert.match(card.message, /Тариф:<\/b> Basic/);
    assert.match(card.message, /Оплачено до:<\/b> 01\.12\.2026 23:59:59/);
  });

  it('does not pick a single tariff button when several accounts match', async () => {
    listed = [];
    accountsError = null;
    accountsForPartner = [account, { ...account, id: 2425, api_login: 'DB2' }];
    const result = await searchUser('998901112233', null as any);
    const card = result.results[0];
    assert.equal(card.accountId, undefined);
    assert.match(card.message, /Аккаунт:<\/b> DB260486-B0BRX2/);
    assert.match(card.message, /Аккаунт:<\/b> DB2/);
  });

  it('still shows the client when account loading fails', async () => {
    listed = [];
    accountsForPartner = [];
    accountsError = new Error('portal down');
    const result = await searchUser('998901112233', null as any);
    assert.equal(result.found, true);
    assert.match(result.results[0].message, /Anvar Suvankulov/);
    assert.doesNotMatch(result.results[0].message, /Аккаунт/);
    assert.equal(result.results[0].accountId, undefined);
  });
});
