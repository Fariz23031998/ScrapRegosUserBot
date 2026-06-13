const {
  openDb,
  partnerFromApiRow,
  partnerAccountFromApiRow,
  licenseFromApiRow,
  upsertPartners,
  upsertPartnerAccounts,
  upsertLicenses,
  startFetchRun,
  finishFetchRun,
  countPartners,
  countPartnerAccounts,
  countLicenses,
  upsertRposClients,
  upsertRposAccounts,
  countRposClients,
  countRposAccounts,
} = require('./partners-db');
const { fetchAllPartners, DEFAULT_PAGE_SIZE: PARTNERS_PAGE_SIZE } = require('./partners-api');
const {
  fetchAllPartnerAccounts,
  DEFAULT_PAGE_SIZE: ACCOUNTS_PAGE_SIZE,
  DEFAULT_ACCOUNT_STATUS,
} = require('./partner-accounts-api');
const { fetchAllLicenses, DEFAULT_PAGE_SIZE: LICENSES_PAGE_SIZE } = require('./licenses-api');
const { fetchAllRposClients, fetchAllRposAccounts } = require('./rpos-api');

function sourceLabel(accountLabel, apiSource) {
  return accountLabel ? `${accountLabel}:${apiSource}` : apiSource;
}

async function syncPartners(request, db, { accountLabel, pageSize = PARTNERS_PAGE_SIZE, onPage } = {}) {
  const runId = startFetchRun(db, sourceLabel(accountLabel, 'api:/Partners/Get'), pageSize);

  const { rows, total, pages } = await fetchAllPartners(request, {
    pageSize,
    onPage,
  });

  const saved = upsertPartners(db, rows.map(partnerFromApiRow));
  finishFetchRun(db, runId, {
    pagesFetched: pages,
    recordsFetched: saved,
    recordsTotal: total,
  });

  return { saved, total, pages, tableTotal: countPartners(db) };
}

async function syncPartnerAccounts(
  request,
  db,
  { accountLabel, pageSize = ACCOUNTS_PAGE_SIZE, accountStatus = DEFAULT_ACCOUNT_STATUS, onPage } = {}
) {
  const runId = startFetchRun(
    db,
    sourceLabel(accountLabel, `api:/PartnerAccounts/Get?account_status=${accountStatus}`),
    pageSize
  );

  const { rows, total, pages } = await fetchAllPartnerAccounts(request, {
    pageSize,
    accountStatus,
    onPage,
  });

  const saved = upsertPartnerAccounts(db, rows.map(partnerAccountFromApiRow));
  finishFetchRun(db, runId, {
    pagesFetched: pages,
    recordsFetched: saved,
    recordsTotal: total,
  });

  return { saved, total, pages, tableTotal: countPartnerAccounts(db) };
}

async function syncLicenses(request, db, { accountLabel, pageSize = LICENSES_PAGE_SIZE, onPage } = {}) {
  const runId = startFetchRun(db, sourceLabel(accountLabel, 'api:/Licenses/Get'), pageSize);

  const { rows, total, pages } = await fetchAllLicenses(request, {
    pageSize,
    onPage,
  });

  const saved = upsertLicenses(db, rows.map(licenseFromApiRow));
  finishFetchRun(db, runId, {
    pagesFetched: pages,
    recordsFetched: saved,
    recordsTotal: total,
  });

  return { saved, total, pages, tableTotal: countLicenses(db) };
}

async function syncRposClients(page, db, { accountLabel, onPage } = {}) {
  const runId = startFetchRun(db, sourceLabel(accountLabel, 'rpos:/admin/license/client/'), null);

  const { rows, total, pages } = await fetchAllRposClients(page, {
    sourceAccount: accountLabel,
    onPage,
  });

  const saved = upsertRposClients(db, rows);
  finishFetchRun(db, runId, {
    pagesFetched: pages,
    recordsFetched: saved,
    recordsTotal: total,
  });

  return { saved, total, pages, tableTotal: countRposClients(db) };
}

async function syncRposAccounts(page, db, { accountLabel, onPage } = {}) {
  const runId = startFetchRun(db, sourceLabel(accountLabel, 'rpos:/admin/license/account/'), null);

  const { rows, total, pages } = await fetchAllRposAccounts(page, {
    sourceAccount: accountLabel,
    onPage,
  });

  const saved = upsertRposAccounts(db, rows);
  finishFetchRun(db, runId, {
    pagesFetched: pages,
    recordsFetched: saved,
    recordsTotal: total,
  });

  return { saved, total, pages, tableTotal: countRposAccounts(db) };
}

module.exports = {
  openDb,
  syncPartners,
  syncPartnerAccounts,
  syncLicenses,
  syncRposClients,
  syncRposAccounts,
};
