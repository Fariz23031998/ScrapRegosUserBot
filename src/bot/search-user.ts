import type { Db } from '../types/db';
import { openDb } from '../db/partners-db';
import { listLinksByFirm } from '../db/client-firm-links';
import { extractPhoneFromText } from './vip-clients';
import { liveSearchPartners, liveSearchPartnerAccounts, liveListPartnerAccounts, liveSearchLicenses, liveSearchVcr1Partners, liveSearchVcr1Licenses, liveSearchRposClients, liveSearchRposAccounts, liveGetPartnerById, liveGetLicenseById, liveGetVcr1PartnerById, liveGetVcr1LicenseById, liveGetRposClientById, liveGetRposAccountById } from '../live/portal-search';
import { TEXT_SEARCH_MIN_LENGTH, TEXT_SEARCH_LIMIT, parseRegosDate, isWithinLastThreeMonths, normalizePhone, normalizeQuery, looksLikePhone, looksLikeInn, phonesMatch, formatWithExpiry, formatPartner, formatRposClient, formatRposAccount, formatLicense, formatVcr1Partner, formatVcr1License, findVcr1PartnerForLicense, resolveVcr1LicenseSupportDate, vcr1LicenseMatchesPartner, buildSearchResult, portalErrorResult, takeLimited, EXPIRED_MESSAGE, PORTAL_ERROR_MESSAGE } from './search-user-format';

async function partnerSearchEntry(partner: any) {
  let accounts: any[] = [];
  if (partner?._account) {
    try {
      accounts = await liveListPartnerAccounts(partner.id, partner._account);
    } catch (err: any) {
      console.error(
        `Partner accounts for ${partner?.id} via ${partner?._account} failed:`,
        err?.message || err
      );
    }
  }
  const entry: any = {
    type: 'partner',
    phone: partner.phone,
    recordId: partner.id,
    clientName: partner.name,
    message: formatWithExpiry(formatPartner(partner, accounts), partner.registered_at),
  };
  if (accounts.length === 1) {
    const account = accounts[0];
    entry.accountId = account.id;
    entry.accountLabel = account._account || partner._account || null;
    entry.apiLogin = account.api_login || null;
    entry.tariff = account.tariff || null;
  }
  return entry;
}

async function searchUser(query: any, db: Db = openDb()) {
  const normalized = normalizeQuery(query);
  if (!normalized) {
    return { found: false, message: 'Не найдено' };
  }

  try {
    const results: any[] = [];

    if (looksLikePhone(normalized) || looksLikeInn(normalized)) {
      const searchTerm = looksLikePhone(normalized)
        ? normalizePhone(normalized).slice(-9)
        : normalized;

      const settled = await Promise.allSettled([
        liveSearchPartners(searchTerm),
        liveSearchVcr1Partners(searchTerm),
        looksLikePhone(normalized) ? liveSearchLicenses(searchTerm) : Promise.resolve([]),
        looksLikePhone(normalized) ? liveSearchRposClients(searchTerm) : Promise.resolve([]),
      ]);
      const values = settled.map((item?: any) => (item.status === 'fulfilled' ? item.value : []));
      const failures = settled
        .filter((item?: any) => item.status === 'rejected')
        .map((item?: any) => item.reason?.message || String(item.reason));
      if (failures.length) {
        console.error('Partial live search failures:', failures.join('; '));
      }
      const [partners, vcr1PartnersRaw, licenses, rposClients] = values;
      if (failures.length === settled.length) {
        throw new Error(failures.join('; '));
      }

      const partnersByPhone = looksLikePhone(normalized)
        ? partners.filter((row?: any) => phonesMatch(row.phone, normalized))
        : partners;

      for (const partner of partnersByPhone) {
        if (looksLikePhone(normalized)) {
          results.push(await partnerSearchEntry(partner));
        } else {
          results.push({
            type: 'partner',
            phone: partner.phone,
            recordId: partner.id,
            clientName: partner.name,
            message: formatWithExpiry(formatPartner(partner), partner.registered_at),
          });
        }
      }

      const vcr1Filtered: any[] = [];
      const seenVcr1: Set<any> = new Set();
      for (const partner of vcr1PartnersRaw) {
        if (seenVcr1.has(partner.id)) continue;
        const phoneOk = looksLikePhone(normalized) && phonesMatch(partner.phone, normalized);
        const innOk = looksLikeInn(normalized) && String(partner.inn || '').trim() === normalized;
        if (!phoneOk && !innOk) continue;
        seenVcr1.add(partner.id);
        vcr1Filtered.push(partner);
      }

      for (const partner of vcr1Filtered) {
        results.push({
          type: 'vcr1_partner',
          phone: partner.phone,
          recordId: partner.id,
          clientName: partner.name,
          message: formatWithExpiry(formatVcr1Partner(partner), partner.registered_at),
        });

        const licenseHits = await liveSearchVcr1Licenses(
          partner.inn || partner.name || searchTerm
        );
        for (const license of licenseHits.filter((lic?: any) => vcr1LicenseMatchesPartner(lic, partner))) {
          results.push({
            type: 'vcr1_license',
            phone: partner.phone,
            recordId: license.id,
            clientName: license.partner || partner.name,
            message: formatWithExpiry(
              formatVcr1License(license, partner),
              partner.registered_at
            ),
          });
        }
      }

      if (looksLikePhone(normalized)) {
        for (const license of licenses.filter((row?: any) => phonesMatch(row.phone, normalized))) {
          results.push({
            type: 'license',
            phone: license.phone,
            recordId: license.id,
            clientName: license.fio,
            message: formatWithExpiry(formatLicense(license), license.generated),
          });
        }

        for (const client of rposClients.filter((row?: any) => phonesMatch(row.phone, normalized))) {
          results.push({
            type: 'rpos_client',
            phone: client.phone,
            recordId: client.id,
            clientName: client.name,
            message: formatWithExpiry(formatRposClient(client), client.created_at),
          });
        }
      }

      if (results.length > 0) {
        return buildSearchResult(results, db);
      }
    }

    const codeSettled = await Promise.allSettled([
      liveSearchLicenses(normalized),
      liveSearchVcr1Licenses(normalized),
      liveSearchRposAccounts(normalized),
      liveSearchPartnerAccounts(normalized),
    ]);
    const codeValues = codeSettled.map((item?: any) =>
      item.status === 'fulfilled' ? item.value : []
    );
    const codeFailures = codeSettled
      .filter((item?: any) => item.status === 'rejected')
      .map((item?: any) => item.reason?.message || String(item.reason));
    if (codeFailures.length) {
      console.error('Partial live code-search failures:', codeFailures.join('; '));
    }
    const [licensesByCode, vcr1ByCode, rposByCode, accountsByLogin] = codeValues;
    if (codeFailures.length === codeSettled.length) {
      throw new Error(codeFailures.join('; '));
    }

    const licenseByCode =
      licensesByCode.find(
        (row?: any) => String(row.code || '').trim().toLowerCase() === normalized.toLowerCase()
      ) || null;
    if (licenseByCode) {
      results.push({
        type: 'license',
        phone: licenseByCode.phone,
        recordId: licenseByCode.id,
        clientName: licenseByCode.fio,
        message: formatWithExpiry(formatLicense(licenseByCode), licenseByCode.generated),
      });
    }

    const vcr1LicenseByCode =
      vcr1ByCode.find((row?: any) => {
        const code = normalized.toLowerCase();
        return [row.serial, row.license, row.fm].some(
          (value?: any) => String(value || '').trim().toLowerCase() === code
        );
      }) || null;
    if (vcr1LicenseByCode) {
      const partner = await findVcr1PartnerForLicense(vcr1LicenseByCode);
      results.push({
        type: 'vcr1_license',
        phone: partner?.phone ?? null,
        recordId: vcr1LicenseByCode.id,
        clientName: vcr1LicenseByCode.partner,
        message: formatWithExpiry(
          formatVcr1License(vcr1LicenseByCode, partner),
          partner?.registered_at || null
        ),
      });
    }

    const rposAccountByCode =
      rposByCode.find(
        (row?: any) => String(row.code || '').trim().toLowerCase() === normalized.toLowerCase()
      ) || null;
    if (rposAccountByCode) {
      results.push({
        type: 'rpos_account',
        phone: extractPhoneFromText(rposAccountByCode.client_name),
        recordId: rposAccountByCode.id,
        clientName: rposAccountByCode.client_name,
        message: formatWithExpiry(formatRposAccount(rposAccountByCode), rposAccountByCode.created_at),
      });
    }

    if (results.length > 0) {
      return buildSearchResult(results, db);
    }

    const account =
      accountsByLogin.find(
        (row?: any) => String(row.api_login || '').trim().toLowerCase() === normalized.toLowerCase()
      ) || null;
    if (account?.partner) {
      const partners = await liveSearchPartners(account.partner);
      const partnerByLogin =
        partners.find(
          (row?: any) => String(row.name || '').trim().toLowerCase() === String(account.partner).trim().toLowerCase()
        ) || partners[0];
      if (partnerByLogin) {
        return buildSearchResult(
          [
            {
              type: 'partner',
              phone: partnerByLogin.phone,
              recordId: partnerByLogin.id,
              clientName: partnerByLogin.name,
              accountId: account.id,
              accountLabel: account._account || null,
              apiLogin: account.api_login || null,
              tariff: account.tariff || null,
              message: formatWithExpiry(
                formatPartner(partnerByLogin, account),
                partnerByLogin.registered_at
              ),
            },
          ],
          db
        );
      }
    }

    return { found: false, message: 'Не найдено' };
  } catch (err: any) {
    return portalErrorResult(err);
  }
}

async function searchFirmByText(query: any, db: Db) {
  const normalized = normalizeQuery(query);
  if (normalized.length < TEXT_SEARCH_MIN_LENGTH) {
    return { found: false, message: 'Не найдено' };
  }

  try {
    const results: any[] = [];
    const textSettled = await Promise.allSettled([
      liveSearchPartners(normalized),
      liveSearchVcr1Partners(normalized),
      liveSearchLicenses(normalized),
      liveSearchRposClients(normalized),
      liveSearchRposAccounts(normalized),
    ]);
    const textValues = textSettled.map((item?: any) =>
      item.status === 'fulfilled' ? item.value : []
    );
    const textFailures = textSettled
      .filter((item?: any) => item.status === 'rejected')
      .map((item?: any) => item.reason?.message || String(item.reason));
    if (textFailures.length) {
      console.error('Partial live text-search failures:', textFailures.join('; '));
    }
    const [partners, vcr1Partners, licenses, rposClients, rposAccounts] = textValues;
    if (textFailures.length === textSettled.length) {
      throw new Error(textFailures.join('; '));
    }

    for (const partner of takeLimited(partners)) {
      results.push({
        type: 'partner',
        phone: partner.phone,
        recordId: partner.id,
        clientName: partner.name,
        message: formatWithExpiry(formatPartner(partner), partner.registered_at),
      });
    }

    for (const partner of takeLimited(vcr1Partners)) {
      results.push({
        type: 'vcr1_partner',
        phone: partner.phone,
        recordId: partner.id,
        clientName: partner.name,
        message: formatWithExpiry(formatVcr1Partner(partner), partner.registered_at),
      });

      const licenseHits = await liveSearchVcr1Licenses(partner.inn || partner.name || normalized);
      for (const license of takeLimited(
        licenseHits.filter((lic?: any) => vcr1LicenseMatchesPartner(lic, partner))
      )) {
        results.push({
          type: 'vcr1_license',
          phone: partner.phone,
          recordId: license.id,
          clientName: license.partner || partner.name,
          message: formatWithExpiry(formatVcr1License(license, partner), partner.registered_at),
        });
      }
    }

    for (const license of takeLimited(licenses)) {
      results.push({
        type: 'license',
        phone: license.phone,
        recordId: license.id,
        clientName: license.fio,
        message: formatWithExpiry(formatLicense(license), license.generated),
      });
    }

    for (const client of takeLimited(rposClients)) {
      results.push({
        type: 'rpos_client',
        phone: client.phone,
        recordId: client.id,
        clientName: client.name,
        message: formatWithExpiry(formatRposClient(client), client.created_at),
      });
    }

    for (const account of takeLimited(rposAccounts)) {
      results.push({
        type: 'rpos_account',
        phone: extractPhoneFromText(account.client_name),
        recordId: account.id,
        clientName: account.client_name,
        message: formatWithExpiry(formatRposAccount(account), account.created_at),
      });
    }

    return buildSearchResult(results, db);
  } catch (err: any) {
    return portalErrorResult(err);
  }
}

async function getFirmCardByTypeAndId(db: Db, type?: any, recordId?: any) {
  const firmType = String(type || '').trim();
  const id = String(recordId ?? '').trim();
  if (!firmType || !id) return null;

  try {
    let entry: any = null;

    if (firmType === 'partner') {
      const partner = await liveGetPartnerById(id);
      if (partner) {
        entry = await partnerSearchEntry(partner);
      }
    } else if (firmType === 'vcr1_partner') {
      const partner = await liveGetVcr1PartnerById(id);
      if (partner) {
        entry = {
          type: 'vcr1_partner',
          phone: partner.phone,
          recordId: partner.id,
          clientName: partner.name,
          message: formatWithExpiry(formatVcr1Partner(partner), partner.registered_at),
        };
      }
    } else if (firmType === 'vcr1_license') {
      const license = await liveGetVcr1LicenseById(id);
      if (license) {
        const partner = await findVcr1PartnerForLicense(license, null);
        entry = {
          type: 'vcr1_license',
          phone: partner?.phone || null,
          recordId: license.id,
          clientName: license.partner || partner?.name || null,
          message: formatWithExpiry(
            formatVcr1License(license, partner),
            partner?.registered_at || null
          ),
        };
      }
    } else if (firmType === 'license') {
      const license = await liveGetLicenseById(id);
      if (license) {
        entry = {
          type: 'license',
          phone: license.phone,
          recordId: license.id,
          clientName: license.fio,
          message: formatWithExpiry(formatLicense(license), license.generated),
        };
      }
    } else if (firmType === 'rpos_client') {
      const client = await liveGetRposClientById(id);
      if (client) {
        entry = {
          type: 'rpos_client',
          phone: client.phone,
          recordId: client.id,
          clientName: client.name,
          message: formatWithExpiry(formatRposClient(client), client.created_at),
        };
      }
    } else if (firmType === 'rpos_account') {
      const account = await liveGetRposAccountById(id);
      if (account) {
        entry = {
          type: 'rpos_account',
          phone: null,
          recordId: account.id,
          clientName: account.client_name,
          message: formatWithExpiry(formatRposAccount(account), account.created_at),
        };
      }
    }

    if (entry) {
      const built = buildSearchResult([entry], db);
      return built.found ? built.results[0] : entry;
    }
  } catch (err: any) {
    console.error('Live firm card failed:', err?.message || err);
  }

  return getCachedFirmCard(db, firmType, id);
}

function getCachedFirmCard(db: Db, firmType?: any, recordId?: any) {
  try {
    const link = listLinksByFirm(db, firmType, recordId)[0];
    if (!link) return null;
    if (!link.firm_message && !link.firm_name) return null;
    return {
      type: link.firm_type,
      phone: link.firm_phone || null,
      recordId: link.firm_record_id,
      clientName: link.firm_name || null,
      message: link.firm_message || link.firm_name || null,
    };
  } catch (error: any) {
    console.error('Cached firm card failed:', error?.message || error);
    return null;
  }
}

async function searchFirmAdmin(query: any, db: Db = openDb()) {
  const exact = await searchUser(query, db);
  if (exact.found || (exact as { error?: boolean }).error) {
    return exact;
  }
  return searchFirmByText(query, db);
}

export {
  searchUser,
  searchFirmAdmin,
  getFirmCardByTypeAndId,
  isWithinLastThreeMonths,
  parseRegosDate,
  normalizePhone,
  phonesMatch,
  looksLikePhone,
  looksLikeInn,
  formatPartner,
  formatLicense,
  formatVcr1Partner,
  formatVcr1License,
  formatRposClient,
  formatRposAccount,
  findVcr1PartnerForLicense,
  resolveVcr1LicenseSupportDate,
  EXPIRED_MESSAGE,
  PORTAL_ERROR_MESSAGE,
};
