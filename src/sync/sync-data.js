/**
 * @deprecated Full catalog sync into SQLite was removed.
 * Firm/partner/license data is queried live from portals on each search.
 * Use `npm run login:sessions` to warm authentication cookies.
 */

const { openDb } = require('../db/partners-db');

function removed(name) {
  return async function deprecatedSync() {
    throw new Error(
      `${name} was removed. Portal data is queried live on search. Run: npm run login:sessions`
    );
  };
}

module.exports = {
  openDb,
  syncPartners: removed('syncPartners'),
  syncPartnerAccounts: removed('syncPartnerAccounts'),
  syncLicenses: removed('syncLicenses'),
  syncRposClients: removed('syncRposClients'),
  syncRposAccounts: removed('syncRposAccounts'),
  syncVcr1Partners: removed('syncVcr1Partners'),
  syncVcr1Licenses: removed('syncVcr1Licenses'),
};
