const { openDb } = require('./partners-db');
const { loadVipClients, isVipClient, VIP_LABEL, extractPhoneFromText } = require('./vip-clients');

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
    'Партнёр',
    `ID: ${partner.id}`,
    `Имя: ${partner.name}`,
    `Правовой статус: ${partner.legal_status || '-'}`,
    `Телефон: ${partner.phone || '-'}`,
    `Контакты: ${partner.contacts || '-'}`,
    `Примечание: ${partner.description || '-'}`,
    `Модерация: ${partner.moderation_status || '-'}`,
    `Баланс: ${partner.balance || '-'}`,
    `Зарегистрирован: ${partner.registered_at || '-'}`,
  ].join('\n');
}

function formatRposClient(client) {
  return [
    'Лицензия',
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
    'Лицензия',
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
    'Лицензия',
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

function findAllPartnersByPhone(db, query) {
  if (!looksLikePhone(query)) return [];
  const partners = db.prepare("SELECT * FROM partners WHERE phone IS NOT NULL AND phone != ''").all();
  return partners.filter((row) => phonesMatch(row.phone, query));
}

function findAllLicensesByPhone(db, query) {
  if (!looksLikePhone(query)) return [];
  const licenses = db.prepare("SELECT * FROM licenses WHERE phone IS NOT NULL AND phone != ''").all();
  return licenses.filter((row) => phonesMatch(row.phone, query));
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

function applyVipToMessage(message, phone, vipClients = loadVipClients()) {
  if (!isVipClient(phone, vipClients)) {
    return message;
  }

  let updated = message;
  const expiredPrefix = `${EXPIRED_MESSAGE}\n\n`;
  if (updated.startsWith(expiredPrefix)) {
    updated = updated.slice(expiredPrefix.length);
  } else if (updated === EXPIRED_MESSAGE) {
    updated = '';
  }

  return updated ? `${updated}\n\n${VIP_LABEL}` : VIP_LABEL;
}

function buildSearchResult(results) {
  if (results.length === 0) {
    return { found: false, message: 'Не найдено' };
  }

  const vipClients = loadVipClients();
  const finalized = results.map((entry) => ({
    ...entry,
    message: applyVipToMessage(entry.message, entry.phone, vipClients),
  }));

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
      return buildSearchResult(results);
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
    return buildSearchResult(results);
  }

  const partnerByLogin = findPartnerByAccountLogin(db, normalized);
  if (partnerByLogin) {
    return buildSearchResult([
      {
        type: 'partner',
        phone: partnerByLogin.phone,
        recordId: partnerByLogin.id,
        clientName: partnerByLogin.name,
        message: formatWithExpiry(formatPartner(partnerByLogin), partnerByLogin.registered_at),
      },
    ]);
  }

  return { found: false, message: 'Не найдено' };
}

module.exports = {
  searchUser,
  isWithinLastThreeMonths,
  parseRegosDate,
  normalizePhone,
  phonesMatch,
  looksLikePhone,
  formatPartner,
  formatLicense,
  formatRposClient,
  formatRposAccount,
  EXPIRED_MESSAGE,
};
