import { getConfiguredAccounts, hasRposCredentials } from '../sync/accounts';
import { withRegosSession, withRposSession } from './session-manager';
import { searchPartners } from '../sync/partners-api';
import { searchPartnerAccounts, searchPartnerAccountsForPartner } from '../sync/partner-accounts-api';
import { fetchPartnerAccountDetail, parsePartnerAccountOverview } from '../sync/partner-accounts-detail';
import { searchLicenses } from '../sync/licenses-api';
import { searchVcr1Partners } from '../sync/vcr1-partners-api';
import { searchVcr1Licenses } from '../sync/vcr1-licenses-api';
import { searchRposClients, searchRposAccounts } from '../sync/rpos-api';
import { partnerFromApiRow, partnerAccountFromApiRow, licenseFromApiRow, vcr1PartnerFromApiRow, vcr1LicenseFromApiRow } from './mappers';
import { cachedSearch } from './portal-cache';

function dedupeById(rows?: any) {
  const seen: Set<any> = new Set();
  const out: any[] = [];
  for (const row of rows) {
    const id = String(row?.id ?? '');
    if (!id) continue;
    const account = String(row?._account ?? '').trim();
    const key = account ? `${account}:${id}` : id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function mapSettled(label?: any, promise?: any) {
  try {
    return await promise;
  } catch (err: any) {
    const error = new Error(`${label}: ${err.message || err}`);
    error.cause = err;
    throw error;
  }
}

async function forEachRegosAccount(worker?: any) {
  const accounts = getConfiguredAccounts();
  if (!accounts.length) {
    throw new Error('No Regos accounts configured in .env');
  }
  const settled = await Promise.allSettled(
    accounts.map((accountLabel?: any) =>
      withRegosSession(accountLabel, (request?: any) => worker(request, accountLabel))
    )
  );
  const rows: any[] = [];
  const errors: any[] = [];
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

async function forEachRposAccount(worker?: any) {
  const accounts = getConfiguredAccounts().filter((name?: any) => hasRposCredentials(name));
  if (!accounts.length) return [];
  const settled = await Promise.allSettled(
    accounts.map((accountLabel?: any) =>
      withRposSession(accountLabel, (request?: any) => worker(request, accountLabel))
    )
  );
  const rows: any[] = [];
  const errors: any[] = [];
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

async function liveSearchPartners(query?: any) {
  return cachedSearch('partners', query, async () => {
    const rows = await forEachRegosAccount(async (request?: any, accountLabel?: any) => {
      const { rows: data } = await mapSettled(
        `${accountLabel} partners`,
        searchPartners(request, query)
      );
      return data.map((row?: any) => ({ ...partnerFromApiRow(row), _account: accountLabel }));
    });
    return dedupeById(rows);
  });
}

async function liveSearchPartnerAccounts(query?: any) {
  return cachedSearch('partner_accounts', query, async () => {
    const rows = await forEachRegosAccount(async (request?: any, accountLabel?: any) => {
      const { rows: data } = await mapSettled(
        `${accountLabel} partner_accounts`,
        searchPartnerAccounts(request, query)
      );
      return data.map((row?: any) => ({ ...partnerAccountFromApiRow(row), _account: accountLabel }));
    });
    return dedupeById(rows);
  });
}

async function liveListPartnerAccounts(partnerId?: any, accountLabel?: any) {
  const id = String(partnerId ?? '').trim();
  const label = String(accountLabel ?? '').trim();
  if (!id || !label) return [];
  const { rows } = await withRegosSession(label, (request?: any) =>
    searchPartnerAccountsForPartner(request, id)
  );
  return (rows || []).map((row?: any) => ({ ...partnerAccountFromApiRow(row), _account: label }));
}

async function liveSearchLicenses(query?: any) {
  return cachedSearch('licenses', query, async () => {
    const rows = await forEachRegosAccount(async (request?: any, accountLabel?: any) => {
      const { rows: data } = await mapSettled(
        `${accountLabel} licenses`,
        searchLicenses(request, query)
      );
      return data.map((row?: any) => ({ ...licenseFromApiRow(row), _account: accountLabel }));
    });
    return dedupeById(rows);
  });
}

async function liveSearchVcr1Partners(query?: any) {
  return cachedSearch('vcr1_partners', query, async () => {
    const rows = await forEachRegosAccount(async (request?: any, accountLabel?: any) => {
      const { rows: data } = await mapSettled(
        `${accountLabel} vcr1_partners`,
        searchVcr1Partners(request, query)
      );
      return data.map((row?: any) => ({ ...vcr1PartnerFromApiRow(row), _account: accountLabel }));
    });
    return dedupeById(rows);
  });
}

async function liveSearchVcr1Licenses(query?: any) {
  return cachedSearch('vcr1_licenses', query, async () => {
    const rows = await forEachRegosAccount(async (request?: any, accountLabel?: any) => {
      const { rows: data } = await mapSettled(
        `${accountLabel} vcr1_licenses`,
        searchVcr1Licenses(request, query)
      );
      return data.map((row?: any) => ({ ...vcr1LicenseFromApiRow(row), _account: accountLabel }));
    });
    return dedupeById(rows);
  });
}

async function liveSearchRposClients(query?: any) {
  return cachedSearch('rpos_clients', query, async () =>
    forEachRposAccount(async (request?: any, accountLabel?: any) => {
      const { rows } = await mapSettled(
        `${accountLabel} rpos_clients`,
        searchRposClients(request, query, { sourceAccount: accountLabel })
      );
      return rows;
    })
  );
}

async function liveSearchRposAccounts(query?: any) {
  return cachedSearch('rpos_accounts', query, async () =>
    forEachRposAccount(async (request?: any, accountLabel?: any) => {
      const { rows } = await mapSettled(
        `${accountLabel} rpos_accounts`,
        searchRposAccounts(request, query, { sourceAccount: accountLabel })
      );
      return rows;
    })
  );
}

async function liveGetPartnerById(id?: any) {
  const rows = await liveSearchPartners(String(id));
  return rows.find((row?: any) => String(row.id) === String(id)) || null;
}

/**
 * Fetch PartnerAccounts Detail overview for an account id.
 * Prefers the session that found the list row; falls back across configured accounts.
 */
async function liveGetPartnerAccountDetail(id: any, preferredAccountLabel: any = null) {
  const accountId = String(id ?? '').trim();
  if (!accountId) {
    throw new Error('Partner account id is required');
  }

  const configured = getConfiguredAccounts();
  if (!configured.length) {
    throw new Error('No Regos accounts configured in .env');
  }

  const ordered: any[] = [];
  if (preferredAccountLabel && configured.includes(preferredAccountLabel)) {
    ordered.push(preferredAccountLabel);
  }
  for (const label of configured) {
    if (!ordered.includes(label)) ordered.push(label);
  }

  const errors: any[] = [];
  for (const accountLabel of ordered) {
    try {
      const overview = await withRegosSession(accountLabel, async (request?: any) => {
        const html = await fetchPartnerAccountDetail(request, accountId);
        return parsePartnerAccountOverview(html);
      });
      return { ...overview, id: accountId, _account: accountLabel };
    } catch (err: any) {
      const message = err?.message || String(err);
      console.error(`PartnerAccounts/Detail via ${accountLabel} failed:`, message);
      errors.push(`${accountLabel}: ${message}`);
    }
  }

  throw new Error(errors.join('; ') || 'PartnerAccounts/Detail failed');
}

async function liveGetLicenseById(id?: any) {
  const rows = await liveSearchLicenses(String(id));
  return rows.find((row?: any) => String(row.id) === String(id)) || null;
}

async function liveGetVcr1PartnerById(id?: any) {
  const rows = await liveSearchVcr1Partners(String(id));
  return rows.find((row?: any) => String(row.id) === String(id)) || null;
}

async function liveGetVcr1LicenseById(id?: any) {
  const rows = await liveSearchVcr1Licenses(String(id));
  return rows.find((row?: any) => String(row.id) === String(id)) || null;
}

async function liveGetRposClientById(id?: any) {
  const rows = await liveSearchRposClients(String(id));
  return rows.find((row?: any) => String(row.id) === String(id)) || null;
}

async function liveGetRposAccountById(id?: any) {
  const rows = await liveSearchRposAccounts(String(id));
  return rows.find((row?: any) => String(row.id) === String(id)) || null;
}

export {
  liveSearchPartners,
  liveSearchPartnerAccounts,
  liveListPartnerAccounts,
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
