import { openDb } from '../db/partners-db';

/**
 * @deprecated Full catalog sync into SQLite was removed.
 * Firm/partner/license data is queried live from portals on each search.
 * Use `npm run login:sessions` to warm authentication cookies.
 */

function removed(name?: any) {
  return async function deprecatedSync() {
    throw new Error(
      `${name} was removed. Portal data is queried live on search. Run: npm run login:sessions`
    );
  };
}

const syncPartners = removed('syncPartners');
const syncPartnerAccounts = removed('syncPartnerAccounts');
const syncLicenses = removed('syncLicenses');
const syncRposClients = removed('syncRposClients');
const syncRposAccounts = removed('syncRposAccounts');
const syncVcr1Partners = removed('syncVcr1Partners');
const syncVcr1Licenses = removed('syncVcr1Licenses');

export {
  openDb,
  syncPartners,
  syncPartnerAccounts,
  syncLicenses,
  syncRposClients,
  syncRposAccounts,
  syncVcr1Partners,
  syncVcr1Licenses,
};
