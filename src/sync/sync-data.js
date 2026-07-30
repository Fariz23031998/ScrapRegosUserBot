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
  vcr1PartnerFromApiRow,
  upsertVcr1Partners,
  countVcr1Partners,
  vcr1LicenseFromApiRow,
  upsertVcr1Licenses,
  countVcr1Licenses,
} = require('../db/partners-db');
const { fetchAllPartners, DEFAULT_PAGE_SIZE: PARTNERS_PAGE_SIZE } = require('./partners-api');
const {
  fetchAllPartnerAccounts,
  DEFAULT_PAGE_SIZE: ACCOUNTS_PAGE_SIZE,
  DEFAULT_ACCOUNT_STATUS,
} = require('./partner-accounts-api');
const { fetchAllLicenses, DEFAULT_PAGE_SIZE: LICENSES_PAGE_SIZE } = require('./licenses-api');
const { fetchAllRposClients, fetchAllRposAccounts } = require('./rpos-api');
const {
  fetchAllVcr1Partners,
  DEFAULT_PAGE_SIZE: VCR1_PARTNERS_PAGE_SIZE,
} = require('./vcr1-partners-api');
const {
  fetchAllVcr1Licenses,
  DEFAULT_PAGE_SIZE: VCR1_LICENSES_PAGE_SIZE,
} = require('./vcr1-licenses-api');

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

async function syncVcr1Partners(
  request,
  db,
  { accountLabel, pageSize = VCR1_PARTNERS_PAGE_SIZE, onPage } = {}
) {
  const runId = startFetchRun(db, sourceLabel(accountLabel, 'vcr1:/Partners/Get'), pageSize);

  const { rows, total, pages } = await fetchAllVcr1Partners(request, {
    pageSize,
    onPage,
  });

  const saved = upsertVcr1Partners(db, rows.map(vcr1PartnerFromApiRow));
  finishFetchRun(db, runId, {
    pagesFetched: pages,
    recordsFetched: saved,
    recordsTotal: total,
  });

  return { saved, total, pages, tableTotal: countVcr1Partners(db) };
}

async function syncVcr1Licenses(
  request,
  db,
  { accountLabel, pageSize = VCR1_LICENSES_PAGE_SIZE, onPage } = {}
) {
  const runId = startFetchRun(db, sourceLabel(accountLabel, 'vcr1:/Licenses/Get'), pageSize);

  const { rows, total, pages } = await fetchAllVcr1Licenses(request, {
    pageSize,
    onPage,
  });

  const saved = upsertVcr1Licenses(db, rows.map(vcr1LicenseFromApiRow));
  finishFetchRun(db, runId, {
    pagesFetched: pages,
    recordsFetched: saved,
    recordsTotal: total,
  });

  return { saved, total, pages, tableTotal: countVcr1Licenses(db) };
}

module.exports = {
  openDb,
  syncPartners,
  syncPartnerAccounts,
  syncLicenses,
  syncRposClients,
  syncRposAccounts,
  syncVcr1Partners,
  syncVcr1Licenses,
};
