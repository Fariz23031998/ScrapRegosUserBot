const { openDb } = require('../db/partners-db');
const { loadVipClients, isVipClient, VIP_LABEL, extractPhoneFromText } = require('./vip-clients');
const {
  getActiveTechnicalSupportSubscription,
  formatSupportUntilLabel,
} = require('../db/technical-support');
const {
  liveSearchPartners,
  liveSearchPartnerAccounts,
  liveSearchLicenses,
  liveSearchVcr1Partners,
  liveSearchVcr1Licenses,
  liveSearchRposClients,
  liveSearchRposAccounts,
  liveGetPartnerById,
  liveGetLicenseById,
  liveGetVcr1PartnerById,
  liveGetVcr1LicenseById,
  liveGetRposClientById,
  liveGetRposAccountById,
} = require('../live/portal-search');
const { bold, field } = require('./telegram-html');

const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;
const EXPIRED_MESSAGE = `⚠️ ${bold('Срок технической поддержки истёк')}`;
const PORTAL_ERROR_MESSAGE = 'Ошибка загрузки данных с портала. Попробуйте ещё раз.';
const TEXT_SEARCH_MIN_LENGTH = 2;
const TEXT_SEARCH_LIMIT = 20;

const RUSSIAN_MONTHS = {
  января: 0,
  февраля: 1,
  марта: 2,
  апреля: 3,
  мая: 4,
  июня: 5,
  июля: 6,
  августа: 7,
  сентября: 8,
  октября: 9,
  ноября: 10,
  декабря: 11,
};

function parseRegosDate(value) {
  if (!value) return null;
  const text = String(value).trim();

  let match = text.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    const [, day, month, year, hour = '0', minute = '0', second = '0'] = match;
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  match = text.match(/^(\d{1,2})\s+([а-яё]+)\s+(\d{4})\s+г\.(?:\s+(\d{1,2}):(\d{2}))?$/i);
  if (match) {
    const [, day, monthName, year, hour = '0', minute = '0'] = match;
    const month = RUSSIAN_MONTHS[monthName.toLowerCase()];
    if (month === undefined) return null;
    const date = new Date(Number(year), month, Number(day), Number(hour), Number(minute), 0);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function isWithinLastThreeMonths(dateValue) {
  const date = dateValue instanceof Date ? dateValue : parseRegosDate(dateValue);
  if (!date) return false;
  return Date.now() - date.getTime() <= THREE_MONTHS_MS;
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeQuery(value) {
  return String(value || '').trim();
}

function looksLikePhone(query) {
  return normalizePhone(query).length >= 7;
}

function looksLikeInn(query) {
  return /^\d{9,14}$/.test(normalizeQuery(query));
}

function phonesMatch(storedPhone, queryPhone) {
  const stored = normalizePhone(storedPhone);
  const query = normalizePhone(queryPhone);
  if (!stored || !query) return false;
  if (stored === query) return true;
  if (stored.endsWith(query) || query.endsWith(stored)) return true;
  const storedTail = stored.slice(-9);
  const queryTail = query.slice(-9);
  return storedTail.length >= 9 && storedTail === queryTail;
}

function formatWithExpiry(formatted, dateValue) {
  if (isWithinLastThreeMonths(dateValue)) {
    return formatted;
  }
  return `${EXPIRED_MESSAGE}\n\n${formatted}`;
}

function formatPartner(partner, account = null) {
  const lines = [
    `🏢 ${bold('Regos')}`,
    field('🆔', 'ID', partner.id),
    field('👤', 'Имя', partner.name),
    field('📋', 'Правовой статус', partner.legal_status || '-'),
    field('📞', 'Телефон', partner.phone || '-'),
    field('📇', 'Контакты', partner.contacts || '-'),
    field('📝', 'Примечание', partner.description || '-'),
    field('✅', 'Модерация', partner.moderation_status || '-'),
    field('💰', 'Баланс', partner.balance ?? '-'),
    field('📅', 'Зарегистрирован', partner.registered_at || '-'),
  ];
  if (account) {
    lines.push(field('📦', 'Тариф', account.tariff || '-'));
    lines.push(field('📆', 'Оплачено до', account.paid_until || '-'));
  }
  return lines.join('\n');
}

function formatRposClient(client) {
  return [
    `🖥️ ${bold('RPOS')}`,
    field('🆔', 'ID', client.id),
    field('👤', 'Имя', client.name),
    field('📞', 'Телефон', client.phone || '-'),
    field('🔑', 'Код', '-'),
    field('📅', 'Создано', client.created_at || '-'),
    field('📡', 'Источник', 'RPOS'),
  ].join('\n');
}

function formatRposAccount(account) {
  return [
    `🖥️ ${bold('RPOS')}`,
    field('🆔', 'ID', account.id),
    field('👤', 'Имя', account.client_name || '-'),
    field('📞', 'Телефон', '-'),
    field('🔑', 'Код', account.code || '-'),
    field('📅', 'Создано', account.created_at || '-'),
    field('📡', 'Источник', 'RPOS'),
  ].join('\n');
}

function formatLicense(license) {
  return [
    `🧾 ${bold('EasyTrade')}`,
    field('🆔', 'ID', license.id),
    field('👤', 'Имя', license.fio),
    field('📞', 'Телефон', license.phone || '-'),
    field('🔑', 'Код', license.code || '-'),
    field('📦', 'Тип', license.type || '-'),
    field('📄', 'Договор', license.contract || '-'),
    field('📌', 'Статус', license.active || '-'),
    field('📅', 'Создано', license.generated || '-'),
    field('🛠', 'Поддержка', license.support || '-'),
    field('🤝', 'Партнёр', license.partner || '-'),
    field('📞', 'Телефон партнёра', license.partner_phone || '-'),
    field('📍', 'Адрес', license.adr || '-'),
    field('📝', 'Примечание', license.note || '-'),
  ].join('\n');
}

function formatVcr1Partner(partner) {
  return [
    `📟 ${bold('VCR')}`,
    field('🆔', 'ID', partner.id),
    field('👤', 'Имя', partner.name),
    field('🔢', 'ИНН/ПИНФЛ', partner.inn || '-'),
    field('📋', 'Правовой статус', partner.legal_status || '-'),
    field('📞', 'Телефон', partner.phone || '-'),
    field('📇', 'Контакты', partner.contacts || '-'),
    field('🏛', 'Компания', partner.company || '-'),
    field('💰', 'Баланс', partner.balance ?? '-'),
    field('📅', 'Зарегистрирован', partner.registered_at || '-'),
  ].join('\n');
}

function formatVcr1License(license, partner = null) {
  return [
    `📟 ${bold('VCR')}`,
    field('🆔', 'ID', license.id),
    field('🤝', 'Партнёр', license.partner || '-'),
    field('💰', 'Баланс', partner?.balance ?? '-'),
    field('📄', 'Договор', license.contract || '-'),
    field('📅', 'Создано', license.created_at || '-'),
    field('📌', 'Статус', license.status || '-'),
    field('🖨', 'Фискальный модуль', license.fm || '-'),
    field('🔢', 'Серийный номер', license.serial || '-'),
    field('🔑', 'Лицензия', license.license || '-'),
    field('📦', 'FDA', license.fda_version || '-'),
    field('🏗', 'Дата сборки', license.app_build_time || '-'),
    field('🗄', 'Версия БД', license.db_version || '-'),
    field('🧾', 'Последний чек', license.last_receipt_date || '-'),
    field('🔍', 'Последняя попытка проверки', license.last_check_attempt || '-'),
    field('🔄', 'Последняя синхронизация', license.last_sync || '-'),
  ].join('\n');
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/["«»„“”']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractInnFromPartnerLabel(value) {
  const match = String(value || '').match(/\((\d{9,14})\)\s*$/);
  return match ? match[1] : null;
}

function partnerLabelWithoutInn(value) {
  return normalizeName(String(value || '').replace(/\(\d{9,14}\)\s*$/, ''));
}

function namesLooselyMatch(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function vcr1LicenseMatchesPartner(license, partner) {
  if (!license || !partner) return false;

  const inn = extractInnFromPartnerLabel(license.partner);
  if (inn && String(partner.inn || '').trim() === inn) return true;

  const target = partnerLabelWithoutInn(license.partner);
  return (
    namesLooselyMatch(partner.name, target) || namesLooselyMatch(partner.company, target)
  );
}

async function findVcr1PartnerForLicense(license, preferredPhone = null) {
  const partnerLabel = license?.partner;
  if (!partnerLabel && !preferredPhone) return null;

  const searches = [];
  if (preferredPhone) searches.push(normalizePhone(preferredPhone).slice(-9));
  const inn = extractInnFromPartnerLabel(partnerLabel);
  if (inn) searches.push(inn);
  const namePart = partnerLabelWithoutInn(partnerLabel);
  if (namePart) searches.push(namePart.split(' ').slice(0, 3).join(' '));

  const partners = [];
  for (const term of searches.filter(Boolean)) {
    const found = await liveSearchVcr1Partners(term);
    partners.push(...found);
  }

  const unique = [];
  const seen = new Set();
  for (const partner of partners) {
    const key = String(partner.id);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(partner);
  }

  if (preferredPhone) {
    const byPhone = unique.find((partner) => phonesMatch(partner.phone, preferredPhone));
    if (byPhone) return byPhone;
  }

  if (inn) {
    const byInn = unique.find((partner) => String(partner.inn || '').trim() === inn);
    if (byInn) return byInn;
  }

  const target = partnerLabelWithoutInn(partnerLabel);
  if (!target) return null;

  return (
    unique.find(
      (partner) =>
        namesLooselyMatch(partner.name, target) || namesLooselyMatch(partner.company, target)
    ) ?? null
  );
}

async function resolveVcr1LicenseSupportDate(license, preferredPhone = null) {
  const partner = await findVcr1PartnerForLicense(license, preferredPhone);
  return partner ? partner.registered_at : null;
}

function stripExpiredSupportBanner(message) {
  let updated = String(message || '');
  const expiredPrefix = `${EXPIRED_MESSAGE}\n\n`;
  if (updated.startsWith(expiredPrefix)) {
    updated = updated.slice(expiredPrefix.length);
  } else if (updated === EXPIRED_MESSAGE) {
    updated = '';
  }
  return updated;
}

function applyVipToMessage(message, phone, vipClients = loadVipClients()) {
  if (!isVipClient(phone, vipClients)) {
    return message;
  }

  const updated = stripExpiredSupportBanner(message);
  return updated ? `${updated}\n\n${VIP_LABEL}` : VIP_LABEL;
}

function applyTechnicalSupportToMessage(message, phone, db) {
  if (!db || !phone) return message;
  const subscription = getActiveTechnicalSupportSubscription(db, phone);
  if (!subscription) return message;

  const label = formatSupportUntilLabel(subscription.ends_at);
  const withoutExpired = stripExpiredSupportBanner(message);
  if (!label) return withoutExpired;
  const badge = `🛠 ${bold(label)}`;
  return withoutExpired ? `${withoutExpired}\n\n${badge}` : badge;
}

function buildSearchResult(results, db = null) {
  if (results.length === 0) {
    return { found: false, message: 'Не найдено' };
  }

  const vipClients = loadVipClients();
  const finalized = results.map((entry) => {
    let message = applyTechnicalSupportToMessage(entry.message, entry.phone, db);
    message = applyVipToMessage(message, entry.phone, vipClients);
    return {
      ...entry,
      message,
    };
  });

  return {
    found: true,
    type: finalized.length === 1 ? finalized[0].type : 'multiple',
    message: finalized.map((entry) => entry.message).join('\n\n---\n\n'),
    results: finalized,
  };
}

function portalErrorResult(err) {
  console.error('Live portal search failed:', err?.message || err);
  return { found: false, message: PORTAL_ERROR_MESSAGE, error: true };
}

function takeLimited(rows, limit = TEXT_SEARCH_LIMIT) {
  return (rows || []).slice(0, limit);
}

async function searchUser(query, db = openDb()) {
  const normalized = normalizeQuery(query);
  if (!normalized) {
    return { found: false, message: 'Не найдено' };
  }

  try {
    const results = [];

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
      const values = settled.map((item) => (item.status === 'fulfilled' ? item.value : []));
      const failures = settled
        .filter((item) => item.status === 'rejected')
        .map((item) => item.reason?.message || String(item.reason));
      if (failures.length) {
        console.error('Partial live search failures:', failures.join('; '));
      }
      const [partners, vcr1PartnersRaw, licenses, rposClients] = values;
      if (failures.length === settled.length) {
        throw new Error(failures.join('; '));
      }

      const partnersByPhone = looksLikePhone(normalized)
        ? partners.filter((row) => phonesMatch(row.phone, normalized))
        : partners;

      for (const partner of partnersByPhone) {
        results.push({
          type: 'partner',
          phone: partner.phone,
          recordId: partner.id,
          clientName: partner.name,
          message: formatWithExpiry(formatPartner(partner), partner.registered_at),
        });
      }

      const vcr1Filtered = [];
      const seenVcr1 = new Set();
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
        for (const license of licenseHits.filter((lic) => vcr1LicenseMatchesPartner(lic, partner))) {
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
        for (const license of licenses.filter((row) => phonesMatch(row.phone, normalized))) {
          results.push({
            type: 'license',
            phone: license.phone,
            recordId: license.id,
            clientName: license.fio,
            message: formatWithExpiry(formatLicense(license), license.generated),
          });
        }

        for (const client of rposClients.filter((row) => phonesMatch(row.phone, normalized))) {
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
    const codeValues = codeSettled.map((item) =>
      item.status === 'fulfilled' ? item.value : []
    );
    const codeFailures = codeSettled
      .filter((item) => item.status === 'rejected')
      .map((item) => item.reason?.message || String(item.reason));
    if (codeFailures.length) {
      console.error('Partial live code-search failures:', codeFailures.join('; '));
    }
    const [licensesByCode, vcr1ByCode, rposByCode, accountsByLogin] = codeValues;
    if (codeFailures.length === codeSettled.length) {
      throw new Error(codeFailures.join('; '));
    }

    const licenseByCode =
      licensesByCode.find(
        (row) => String(row.code || '').trim().toLowerCase() === normalized.toLowerCase()
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
      vcr1ByCode.find((row) => {
        const code = normalized.toLowerCase();
        return [row.serial, row.license, row.fm].some(
          (value) => String(value || '').trim().toLowerCase() === code
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
        (row) => String(row.code || '').trim().toLowerCase() === normalized.toLowerCase()
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
        (row) => String(row.api_login || '').trim().toLowerCase() === normalized.toLowerCase()
      ) || null;
    if (account?.partner) {
      const partners = await liveSearchPartners(account.partner);
      const partnerByLogin =
        partners.find(
          (row) => String(row.name || '').trim().toLowerCase() === String(account.partner).trim().toLowerCase()
        ) || partners[0];
      if (partnerByLogin) {
        return buildSearchResult(
          [
            {
              type: 'partner',
              phone: partnerByLogin.phone,
              recordId: partnerByLogin.id,
              clientName: partnerByLogin.name,
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
  } catch (err) {
    return portalErrorResult(err);
  }
}

async function searchFirmByText(query, db) {
  const normalized = normalizeQuery(query);
  if (normalized.length < TEXT_SEARCH_MIN_LENGTH) {
    return { found: false, message: 'Не найдено' };
  }

  try {
    const results = [];
    const textSettled = await Promise.allSettled([
      liveSearchPartners(normalized),
      liveSearchVcr1Partners(normalized),
      liveSearchLicenses(normalized),
      liveSearchRposClients(normalized),
      liveSearchRposAccounts(normalized),
    ]);
    const textValues = textSettled.map((item) =>
      item.status === 'fulfilled' ? item.value : []
    );
    const textFailures = textSettled
      .filter((item) => item.status === 'rejected')
      .map((item) => item.reason?.message || String(item.reason));
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
        licenseHits.filter((lic) => vcr1LicenseMatchesPartner(lic, partner))
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
  } catch (err) {
    return portalErrorResult(err);
  }
}

async function getFirmCardByTypeAndId(db, type, recordId) {
  const firmType = String(type || '').trim();
  const id = String(recordId ?? '').trim();
  if (!firmType || !id) return null;

  try {
    let entry = null;

    if (firmType === 'partner') {
      const partner = await liveGetPartnerById(id);
      if (!partner) return null;
      entry = {
        type: 'partner',
        phone: partner.phone,
        recordId: partner.id,
        clientName: partner.name,
        message: formatWithExpiry(formatPartner(partner), partner.registered_at),
      };
    } else if (firmType === 'vcr1_partner') {
      const partner = await liveGetVcr1PartnerById(id);
      if (!partner) return null;
      entry = {
        type: 'vcr1_partner',
        phone: partner.phone,
        recordId: partner.id,
        clientName: partner.name,
        message: formatWithExpiry(formatVcr1Partner(partner), partner.registered_at),
      };
    } else if (firmType === 'vcr1_license') {
      const license = await liveGetVcr1LicenseById(id);
      if (!license) return null;
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
    } else if (firmType === 'license') {
      const license = await liveGetLicenseById(id);
      if (!license) return null;
      entry = {
        type: 'license',
        phone: license.phone,
        recordId: license.id,
        clientName: license.fio,
        message: formatWithExpiry(formatLicense(license), license.generated),
      };
    } else if (firmType === 'rpos_client') {
      const client = await liveGetRposClientById(id);
      if (!client) return null;
      entry = {
        type: 'rpos_client',
        phone: client.phone,
        recordId: client.id,
        clientName: client.name,
        message: formatWithExpiry(formatRposClient(client), client.created_at),
      };
    } else if (firmType === 'rpos_account') {
      const account = await liveGetRposAccountById(id);
      if (!account) return null;
      entry = {
        type: 'rpos_account',
        phone: null,
        recordId: account.id,
        clientName: account.client_name,
        message: formatWithExpiry(formatRposAccount(account), account.created_at),
      };
    } else {
      return null;
    }

    const built = buildSearchResult([entry], db);
    return built.found ? built.results[0] : entry;
  } catch (err) {
    console.error('Live firm card failed:', err?.message || err);
    return null;
  }
}

async function searchFirmAdmin(query, db = openDb()) {
  const exact = await searchUser(query, db);
  if (exact.found || exact.error) {
    return exact;
  }
  return searchFirmByText(query, db);
}

module.exports = {
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
