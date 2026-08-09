const { openDb } = require('../db/partners-db');
const { loadVipClients, isVipClient, VIP_LABEL, extractPhoneFromText } = require('./vip-clients');
const {
  getActiveTechnicalSupportSubscription,
  formatSupportUntilLabel,
} = require('../db/technical-support');

const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;
const EXPIRED_MESSAGE = 'Срок технической поддержки истёк';

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

function formatPartner(partner) {
  return [
    'Regos',
    `ID: ${partner.id}`,
    `Имя: ${partner.name}`,
    `Правовой статус: ${partner.legal_status || '-'}`,
    `Телефон: ${partner.phone || '-'}`,
    `Контакты: ${partner.contacts || '-'}`,
    `Примечание: ${partner.description || '-'}`,
    `Модерация: ${partner.moderation_status || '-'}`,
    `Баланс: ${partner.balance ?? '-'}`,
    `Зарегистрирован: ${partner.registered_at || '-'}`,
  ].join('\n');
}

function formatRposClient(client) {
  return [
    'RPOS',
    `ID: ${client.id}`,
    `Имя: ${client.name}`,
    `Телефон: ${client.phone || '-'}`,
    `Код: -`,
    `Создано: ${client.created_at || '-'}`,
    `Источник: RPOS`,
  ].join('\n');
}

function formatRposAccount(account) {
  return [
    'RPOS',
    `ID: ${account.id}`,
    `Имя: ${account.client_name || '-'}`,
    `Телефон: -`,
    `Код: ${account.code || '-'}`,
    `Создано: ${account.created_at || '-'}`,
    `Источник: RPOS`,
  ].join('\n');
}

function formatLicense(license) {
  return [
    'EasyTrade',
    `ID: ${license.id}`,
    `Имя: ${license.fio}`,
    `Телефон: ${license.phone || '-'}`,
    `Код: ${license.code || '-'}`,
    `Тип: ${license.type || '-'}`,
    `Договор: ${license.contract || '-'}`,
    `Статус: ${license.active || '-'}`,
    `Создано: ${license.generated || '-'}`,
    `Поддержка: ${license.support || '-'}`,
    `Партнёр: ${license.partner || '-'}`,
    `Телефон партнёра: ${license.partner_phone || '-'}`,
    `Адрес: ${license.adr || '-'}`,
    `Примечание: ${license.note || '-'}`,
  ].join('\n');
}

function formatVcr1Partner(partner) {
  return [
    'VCR1',
    `ID: ${partner.id}`,
    `Имя: ${partner.name}`,
    `ИНН/ПИНФЛ: ${partner.inn || '-'}`,
    `Правовой статус: ${partner.legal_status || '-'}`,
    `Телефон: ${partner.phone || '-'}`,
    `Контакты: ${partner.contacts || '-'}`,
    `Компания: ${partner.company || '-'}`,
    `Баланс: ${partner.balance ?? '-'}`,
    `Зарегистрирован: ${partner.registered_at || '-'}`,
  ].join('\n');
}

function formatVcr1License(license, partner = null) {
  return [
    'VCR1',
    `ID: ${license.id}`,
    `Партнёр: ${license.partner || '-'}`,
    `Баланс: ${partner?.balance ?? '-'}`,
    `Договор: ${license.contract || '-'}`,
    `Создано: ${license.created_at || '-'}`,
    `Статус: ${license.status || '-'}`,
    `Фискальный модуль: ${license.fm || '-'}`,
    `Серийный номер: ${license.serial || '-'}`,
    `Лицензия: ${license.license || '-'}`,
    `FDA: ${license.fda_version || '-'}`,
    `Дата сборки: ${license.app_build_time || '-'}`,
    `Версия БД: ${license.db_version || '-'}`,
    `Последний чек: ${license.last_receipt_date || '-'}`,
    `Последняя попытка проверки: ${license.last_check_attempt || '-'}`,
    `Последняя синхронизация: ${license.last_sync || '-'}`,
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

function findVcr1PartnerForLicense(db, license, preferredPhone = null) {
  const partnerLabel = license?.partner;
  if (!partnerLabel && !preferredPhone) return null;

  const partners = db.prepare('SELECT * FROM vcr1_partners').all();

  if (preferredPhone) {
    const byPhone = partners.find((partner) => phonesMatch(partner.phone, preferredPhone));
    if (byPhone) return byPhone;
  }

  const inn = extractInnFromPartnerLabel(partnerLabel);
  if (inn) {
    const byInn = partners.find((partner) => String(partner.inn || '').trim() === inn);
    if (byInn) return byInn;
  }

  const target = partnerLabelWithoutInn(partnerLabel);
  if (!target) return null;

  return (
    partners.find(
      (partner) =>
        namesLooselyMatch(partner.name, target) || namesLooselyMatch(partner.company, target)
    ) ?? null
  );
}

function resolveVcr1LicenseSupportDate(db, license, preferredPhone = null) {
  const partner = findVcr1PartnerForLicense(db, license, preferredPhone);
  // Support status comes only from the matched Partners row (registered_at / 90-day rule).
  // Licenses create/support fields are never used here.
  return partner ? partner.registered_at : null;
}

function findAllPartnersByPhone(db, query) {
  if (!looksLikePhone(query)) return [];
  const partners = db.prepare("SELECT * FROM partners WHERE phone IS NOT NULL AND phone != ''").all();
  return partners.filter((row) => phonesMatch(row.phone, query));
}

function findAllVcr1PartnersByPhone(db, query) {
  if (!looksLikePhone(query)) return [];
  const partners = db
    .prepare("SELECT * FROM vcr1_partners WHERE phone IS NOT NULL AND phone != ''")
    .all();
  return partners.filter((row) => phonesMatch(row.phone, query));
}

function findAllVcr1PartnersByInn(db, query) {
  if (!looksLikeInn(query)) return [];
  const inn = normalizeQuery(query);
  return db
    .prepare('SELECT * FROM vcr1_partners WHERE TRIM(inn) = ?')
    .all(inn);
}

function findAllLicensesByPhone(db, query) {
  if (!looksLikePhone(query)) return [];
  const licenses = db.prepare("SELECT * FROM licenses WHERE phone IS NOT NULL AND phone != ''").all();
  return licenses.filter((row) => phonesMatch(row.phone, query));
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

function findAllVcr1LicensesForPartner(db, partner) {
  if (!partner) return [];
  const licenses = db.prepare('SELECT * FROM vcr1_licenses').all();
  return licenses.filter((license) => vcr1LicenseMatchesPartner(license, partner));
}

function findAllRposClientsByPhone(db, query) {
  if (!looksLikePhone(query)) return [];
  const clients = db.prepare("SELECT * FROM rpos_clients WHERE phone IS NOT NULL AND phone != ''").all();
  return clients.filter((row) => phonesMatch(row.phone, query));
}

function findLicenseByCode(db, query) {
  const code = normalizeQuery(query);
  if (!code) return null;
  return (
    db
      .prepare('SELECT * FROM licenses WHERE LOWER(TRIM(code)) = LOWER(TRIM(?))')
      .get(code) ?? null
  );
}

function findVcr1LicenseByCode(db, query) {
  const code = normalizeQuery(query);
  if (!code) return null;
  return (
    db
      .prepare(
        `SELECT * FROM vcr1_licenses
         WHERE LOWER(TRIM(serial)) = LOWER(TRIM(?))
            OR LOWER(TRIM(license)) = LOWER(TRIM(?))
            OR LOWER(TRIM(fm)) = LOWER(TRIM(?))`
      )
      .get(code, code, code) ?? null
  );
}

function findRposAccountByCode(db, query) {
  const code = normalizeQuery(query);
  if (!code) return null;
  return (
    db
      .prepare('SELECT * FROM rpos_accounts WHERE LOWER(TRIM(code)) = LOWER(TRIM(?))')
      .get(code) ?? null
  );
}

function findPartnerByAccountLogin(db, apiLogin) {
  const login = normalizeQuery(apiLogin);
  if (!login) return null;

  const account = db
    .prepare('SELECT * FROM partner_accounts WHERE LOWER(TRIM(api_login)) = LOWER(TRIM(?))')
    .get(login);
  if (!account) return null;

  return (
    db
      .prepare('SELECT * FROM partners WHERE TRIM(name) = TRIM(?) COLLATE NOCASE')
      .get(account.partner) ?? null
  );
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
  return withoutExpired ? `${withoutExpired}\n\n${label}` : label;
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

function searchUser(query, db = openDb()) {
  const normalized = normalizeQuery(query);
  if (!normalized) {
    return { found: false, message: 'Не найдено' };
  }

  const results = [];

  if (looksLikePhone(normalized)) {
    for (const partner of findAllPartnersByPhone(db, normalized)) {
      results.push({
        type: 'partner',
        phone: partner.phone,
        recordId: partner.id,
        clientName: partner.name,
        message: formatWithExpiry(formatPartner(partner), partner.registered_at),
      });
    }

    const vcr1Partners = [
      ...findAllVcr1PartnersByPhone(db, normalized),
      ...findAllVcr1PartnersByInn(db, normalized),
    ].filter(
      (partner, index, partners) =>
        partners.findIndex((candidate) => candidate.id === partner.id) === index
    );

    for (const partner of vcr1Partners) {
      results.push({
        type: 'vcr1_partner',
        phone: partner.phone,
        recordId: partner.id,
        clientName: partner.name,
        message: formatWithExpiry(formatVcr1Partner(partner), partner.registered_at),
      });

      for (const license of findAllVcr1LicensesForPartner(db, partner)) {
        results.push({
          type: 'vcr1_license',
          phone: partner.phone,
          recordId: license.id,
          clientName: license.partner || partner.name,
          message: formatWithExpiry(
            formatVcr1License(license, partner),
            resolveVcr1LicenseSupportDate(db, license, partner.phone)
          ),
        });
      }
    }

    for (const license of findAllLicensesByPhone(db, normalized)) {
      results.push({
        type: 'license',
        phone: license.phone,
        recordId: license.id,
        clientName: license.fio,
        message: formatWithExpiry(formatLicense(license), license.generated),
      });
    }

    for (const client of findAllRposClientsByPhone(db, normalized)) {
      results.push({
        type: 'rpos_client',
        phone: client.phone,
        recordId: client.id,
        clientName: client.name,
        message: formatWithExpiry(formatRposClient(client), client.created_at),
      });
    }

    if (results.length > 0) {
      return buildSearchResult(results, db);
    }
  }

  const licenseByCode = findLicenseByCode(db, normalized);
  if (licenseByCode) {
    results.push({
      type: 'license',
      phone: licenseByCode.phone,
      recordId: licenseByCode.id,
      clientName: licenseByCode.fio,
      message: formatWithExpiry(formatLicense(licenseByCode), licenseByCode.generated),
    });
  }

  const vcr1LicenseByCode = findVcr1LicenseByCode(db, normalized);
  if (vcr1LicenseByCode) {
    const partner = findVcr1PartnerForLicense(db, vcr1LicenseByCode);
    results.push({
      type: 'vcr1_license',
      phone: partner?.phone ?? null,
      recordId: vcr1LicenseByCode.id,
      clientName: vcr1LicenseByCode.partner,
      message: formatWithExpiry(
        formatVcr1License(vcr1LicenseByCode, partner),
        resolveVcr1LicenseSupportDate(db, vcr1LicenseByCode)
      ),
    });
  }

  const rposAccountByCode = findRposAccountByCode(db, normalized);
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

  const partnerByLogin = findPartnerByAccountLogin(db, normalized);
  if (partnerByLogin) {
    return buildSearchResult(
      [
        {
          type: 'partner',
          phone: partnerByLogin.phone,
          recordId: partnerByLogin.id,
          clientName: partnerByLogin.name,
          message: formatWithExpiry(formatPartner(partnerByLogin), partnerByLogin.registered_at),
        },
      ],
      db
    );
  }

  return { found: false, message: 'Не найдено' };
}

const TEXT_SEARCH_MIN_LENGTH = 2;
const TEXT_SEARCH_LIMIT = 20;

function escapeLikePattern(value) {
  return String(value || '').replace(/([%_\\])/g, '\\$1');
}

function likePattern(query) {
  return `%${escapeLikePattern(normalizeQuery(query))}%`;
}

function findPartnersByNameText(db, query) {
  const pattern = likePattern(query);
  return db
    .prepare(
      `SELECT * FROM partners
       WHERE name COLLATE NOCASE LIKE ? ESCAPE '\\'
       LIMIT ?`
    )
    .all(pattern, TEXT_SEARCH_LIMIT);
}

function findVcr1PartnersByText(db, query) {
  const pattern = likePattern(query);
  return db
    .prepare(
      `SELECT * FROM vcr1_partners
       WHERE name COLLATE NOCASE LIKE ? ESCAPE '\\'
          OR company COLLATE NOCASE LIKE ? ESCAPE '\\'
          OR inn COLLATE NOCASE LIKE ? ESCAPE '\\'
       LIMIT ?`
    )
    .all(pattern, pattern, pattern, TEXT_SEARCH_LIMIT);
}

function findLicensesByText(db, query) {
  const pattern = likePattern(query);
  return db
    .prepare(
      `SELECT * FROM licenses
       WHERE fio COLLATE NOCASE LIKE ? ESCAPE '\\'
          OR partner COLLATE NOCASE LIKE ? ESCAPE '\\'
       LIMIT ?`
    )
    .all(pattern, pattern, TEXT_SEARCH_LIMIT);
}

function findRposClientsByNameText(db, query) {
  const pattern = likePattern(query);
  return db
    .prepare(
      `SELECT * FROM rpos_clients
       WHERE name COLLATE NOCASE LIKE ? ESCAPE '\\'
       LIMIT ?`
    )
    .all(pattern, TEXT_SEARCH_LIMIT);
}

function findRposAccountsByNameText(db, query) {
  const pattern = likePattern(query);
  return db
    .prepare(
      `SELECT * FROM rpos_accounts
       WHERE client_name COLLATE NOCASE LIKE ? ESCAPE '\\'
       LIMIT ?`
    )
    .all(pattern, TEXT_SEARCH_LIMIT);
}

function searchFirmByText(query, db) {
  const normalized = normalizeQuery(query);
  if (normalized.length < TEXT_SEARCH_MIN_LENGTH) {
    return { found: false, message: 'Не найдено' };
  }

  const results = [];

  for (const partner of findPartnersByNameText(db, normalized)) {
    results.push({
      type: 'partner',
      phone: partner.phone,
      recordId: partner.id,
      clientName: partner.name,
      message: formatWithExpiry(formatPartner(partner), partner.registered_at),
    });
  }

  for (const partner of findVcr1PartnersByText(db, normalized)) {
    results.push({
      type: 'vcr1_partner',
      phone: partner.phone,
      recordId: partner.id,
      clientName: partner.name,
      message: formatWithExpiry(formatVcr1Partner(partner), partner.registered_at),
    });

    for (const license of findAllVcr1LicensesForPartner(db, partner)) {
      results.push({
        type: 'vcr1_license',
        phone: partner.phone,
        recordId: license.id,
        clientName: license.partner || partner.name,
        message: formatWithExpiry(
          formatVcr1License(license, partner),
          resolveVcr1LicenseSupportDate(db, license, partner.phone)
        ),
      });
    }
  }

  for (const license of findLicensesByText(db, normalized)) {
    results.push({
      type: 'license',
      phone: license.phone,
      recordId: license.id,
      clientName: license.fio,
      message: formatWithExpiry(formatLicense(license), license.generated),
    });
  }

  for (const client of findRposClientsByNameText(db, normalized)) {
    results.push({
      type: 'rpos_client',
      phone: client.phone,
      recordId: client.id,
      clientName: client.name,
      message: formatWithExpiry(formatRposClient(client), client.created_at),
    });
  }

  for (const account of findRposAccountsByNameText(db, normalized)) {
    results.push({
      type: 'rpos_account',
      phone: extractPhoneFromText(account.client_name),
      recordId: account.id,
      clientName: account.client_name,
      message: formatWithExpiry(formatRposAccount(account), account.created_at),
    });
  }

  return buildSearchResult(results, db);
}

/**
 * Admin firm search: same as searchUser first, then name/company/text fallback.
 * Does not change Telegram bot search behavior (bots call searchUser only).
 */
function searchFirmAdmin(query, db = openDb()) {
  const exact = searchUser(query, db);
  if (exact.found) {
    return exact;
  }
  return searchFirmByText(query, db);
}

module.exports = {
  searchUser,
  searchFirmAdmin,
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
};
