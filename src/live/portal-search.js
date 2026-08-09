const { getConfiguredAccounts, hasRposCredentials } = require('../sync/accounts');
const { withRegosSession, withRposSession } = require('./session-manager');
const { searchPartners } = require('../sync/partners-api');
const { searchPartnerAccounts } = require('../sync/partner-accounts-api');
const {
  fetchPartnerAccountDetail,
  parsePartnerAccountOverview,
} = require('../sync/partner-accounts-detail');
const { searchLicenses } = require('../sync/licenses-api');
const { searchVcr1Partners } = require('../sync/vcr1-partners-api');
const { searchVcr1Licenses } = require('../sync/vcr1-licenses-api');
const { searchRposClients, searchRposAccounts } = require('../sync/rpos-api');
const {
  partnerFromApiRow,
  partnerAccountFromApiRow,
  licenseFromApiRow,
  vcr1PartnerFromApiRow,
  vcr1LicenseFromApiRow,
} = require('./mappers');
const { cachedSearch } = require('./portal-cache');

function dedupeById(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = String(row?.id ?? '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function mapSettled(label, promise) {
  try {
    return await promise;
  } catch (err) {
    const error = new Error(`${label}: ${err.message || err}`);
    error.cause = err;
    throw error;
  }
}

async function forEachRegosAccount(worker) {
  const accounts = getConfiguredAccounts();
  if (!accounts.length) {
    throw new Error('No Regos accounts configured in .env');
  }
  const settled = await Promise.allSettled(
    accounts.map((accountLabel) =>
      withRegosSession(accountLabel, (request) => worker(request, accountLabel))
    )
  );
  const rows = [];
  const errors = [];
  let fulfilled = 0;
  for (let i = 0; i < settled.length; i += 1) {
    const item = settled[i];
    if (item.status === 'fulfilled') {
      fulfilled += 1;
      rows.push(...(item.value || []));
    } else {
      const message = item.reason?.message || String(item.reason);
      console.error(`Regos account ${accounts[i]} failed:`, message);
      errors.push(`${accounts[i]}: ${message}`);
    }
  }
  if (!fulfilled && errors.length) {
    throw new Error(errors.join('; '));
  }
  return rows;
}

async function forEachRposAccount(worker) {
  const accounts = getConfiguredAccounts().filter((name) => hasRposCredentials(name));
  if (!accounts.length) return [];
  const settled = await Promise.allSettled(
    accounts.map((accountLabel) =>
      withRposSession(accountLabel, (request) => worker(request, accountLabel))
    )
  );
  const rows = [];
  const errors = [];
  let fulfilled = 0;
  for (let i = 0; i < settled.length; i += 1) {
    const item = settled[i];
    if (item.status === 'fulfilled') {
      fulfilled += 1;
      rows.push(...(item.value || []));
    } else {
      const message = item.reason?.message || String(item.reason);
      console.error(`RPOS account ${accounts[i]} failed:`, message);
      errors.push(`${accounts[i]}: ${message}`);
    }
  }
  if (!fulfilled && errors.length) {
    throw new Error(errors.join('; '));
  }
  return rows;
}

async function liveSearchPartners(query) {
  return cachedSearch('partners', query, async () => {
    const rows = await forEachRegosAccount(async (request, accountLabel) => {
      const { rows: data } = await mapSettled(
        `${accountLabel} partners`,
        searchPartners(request, query)
      );
      return data.map((row) => ({ ...partnerFromApiRow(row), _account: accountLabel }));
    });
    return dedupeById(rows);
  });
}

async function liveSearchPartnerAccounts(query) {
  return cachedSearch('partner_accounts', query, async () => {
    const rows = await forEachRegosAccount(async (request, accountLabel) => {
      const { rows: data } = await mapSettled(
        `${accountLabel} partner_accounts`,
        searchPartnerAccounts(request, query)
      );
      return data.map((row) => ({ ...partnerAccountFromApiRow(row), _account: accountLabel }));
    });
    return dedupeById(rows);
  });
}

async function liveSearchLicenses(query) {
  return cachedSearch('licenses', query, async () => {
    const rows = await forEachRegosAccount(async (request, accountLabel) => {
      const { rows: data } = await mapSettled(
        `${accountLabel} licenses`,
        searchLicenses(request, query)
      );
      return data.map((row) => ({ ...licenseFromApiRow(row), _account: accountLabel }));
    });
    return dedupeById(rows);
  });
}

async function liveSearchVcr1Partners(query) {
  return cachedSearch('vcr1_partners', query, async () => {
    const rows = await forEachRegosAccount(async (request, accountLabel) => {
      const { rows: data } = await mapSettled(
        `${accountLabel} vcr1_partners`,
        searchVcr1Partners(request, query)
      );
      return data.map((row) => ({ ...vcr1PartnerFromApiRow(row), _account: accountLabel }));
    });
    return dedupeById(rows);
  });
}

async function liveSearchVcr1Licenses(query) {
  return cachedSearch('vcr1_licenses', query, async () => {
    const rows = await forEachRegosAccount(async (request, accountLabel) => {
      const { rows: data } = await mapSettled(
        `${accountLabel} vcr1_licenses`,
        searchVcr1Licenses(request, query)
      );
      return data.map((row) => ({ ...vcr1LicenseFromApiRow(row), _account: accountLabel }));
    });
    return dedupeById(rows);
  });
}

async function liveSearchRposClients(query) {
  return cachedSearch('rpos_clients', query, async () =>
    forEachRposAccount(async (request, accountLabel) => {
      const { rows } = await mapSettled(
        `${accountLabel} rpos_clients`,
        searchRposClients(request, query, { sourceAccount: accountLabel })
      );
      return rows;
    })
  );
}

async function liveSearchRposAccounts(query) {
  return cachedSearch('rpos_accounts', query, async () =>
    forEachRposAccount(async (request, accountLabel) => {
      const { rows } = await mapSettled(
        `${accountLabel} rpos_accounts`,
        searchRposAccounts(request, query, { sourceAccount: accountLabel })
      );
      return rows;
    })
  );
}

async function liveGetPartnerById(id) {
  const rows = await liveSearchPartners(String(id));
  return rows.find((row) => String(row.id) === String(id)) || null;
}

/**
 * Fetch PartnerAccounts Detail overview for an account id.
 * Prefers the session that found the list row; falls back across configured accounts.
 */
async function liveGetPartnerAccountDetail(id, preferredAccountLabel = null) {
  const accountId = String(id ?? '').trim();
  if (!accountId) {
    throw new Error('Partner account id is required');
  }

  const configured = getConfiguredAccounts();
  if (!configured.length) {
    throw new Error('No Regos accounts configured in .env');
  }

  const ordered = [];
  if (preferredAccountLabel && configured.includes(preferredAccountLabel)) {
    ordered.push(preferredAccountLabel);
  }
  for (const label of configured) {
    if (!ordered.includes(label)) ordered.push(label);
  }

  const errors = [];
  for (const accountLabel of ordered) {
    try {
      const overview = await withRegosSession(accountLabel, async (request) => {
        const html = await fetchPartnerAccountDetail(request, accountId);
        return parsePartnerAccountOverview(html);
      });
      return { ...overview, id: accountId, _account: accountLabel };
    } catch (err) {
      const message = err?.message || String(err);
      console.error(`PartnerAccounts/Detail via ${accountLabel} failed:`, message);
      errors.push(`${accountLabel}: ${message}`);
    }
  }

  throw new Error(errors.join('; ') || 'PartnerAccounts/Detail failed');
}

async function liveGetLicenseById(id) {
  const rows = await liveSearchLicenses(String(id));
  return rows.find((row) => String(row.id) === String(id)) || null;
}

async function liveGetVcr1PartnerById(id) {
  const rows = await liveSearchVcr1Partners(String(id));
  return rows.find((row) => String(row.id) === String(id)) || null;
}

async function liveGetVcr1LicenseById(id) {
  const rows = await liveSearchVcr1Licenses(String(id));
  return rows.find((row) => String(row.id) === String(id)) || null;
}

async function liveGetRposClientById(id) {
  const rows = await liveSearchRposClients(String(id));
  return rows.find((row) => String(row.id) === String(id)) || null;
}

async function liveGetRposAccountById(id) {
  const rows = await liveSearchRposAccounts(String(id));
  return rows.find((row) => String(row.id) === String(id)) || null;
}

module.exports = {
  liveSearchPartners,
  liveSearchPartnerAccounts,
  liveSearchLicenses,
  liveSearchVcr1Partners,
  liveSearchVcr1Licenses,
  liveSearchRposClients,
  liveSearchRposAccounts,
  liveGetPartnerById,
  liveGetPartnerAccountDetail,
  liveGetLicenseById,
  liveGetVcr1PartnerById,
  liveGetVcr1LicenseById,
  liveGetRposClientById,
  liveGetRposAccountById,
};
