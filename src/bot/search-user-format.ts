import type { Db } from '../types/db';
import { loadVipClients, isVipClient, VIP_LABEL } from './vip-clients';
import { getActiveTechnicalSupportSubscription, formatSupportUntilLabel } from '../db/technical-support';
import { liveSearchVcr1Partners } from '../live/portal-search';
import { bold, field } from './telegram-html';

const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;
const EXPIRED_MESSAGE = `⚠️ ${bold('Срок технической поддержки истёк')}`;
const PORTAL_ERROR_MESSAGE = 'Ошибка загрузки данных с портала. Попробуйте ещё раз.';
const TEXT_SEARCH_MIN_LENGTH = 2;
const TEXT_SEARCH_LIMIT = 20;

const RUSSIAN_MONTHS: Record<string, number> = {
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

function parseRegosDate(value?: any) {
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

function isWithinLastThreeMonths(dateValue?: any) {
  const date = dateValue instanceof Date ? dateValue : parseRegosDate(dateValue);
  if (!date) return false;
  return Date.now() - date.getTime() <= THREE_MONTHS_MS;
}

function normalizePhone(value?: any) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeQuery(value?: any) {
  return String(value || '').trim();
}

function looksLikePhone(query?: any) {
  return normalizePhone(query).length >= 7;
}

function looksLikeInn(query?: any) {
  return /^\d{9,14}$/.test(normalizeQuery(query));
}

function phonesMatch(storedPhone?: any, queryPhone?: any) {
  const stored = normalizePhone(storedPhone);
  const query = normalizePhone(queryPhone);
  if (!stored || !query) return false;
  if (stored === query) return true;
  if (stored.endsWith(query) || query.endsWith(stored)) return true;
  const storedTail = stored.slice(-9);
  const queryTail = query.slice(-9);
  return storedTail.length >= 9 && storedTail === queryTail;
}

const BILLING_PAGE_LABELS: Record<string, string> = {
  SAMARKAND: 'Samarkand',
  BUKHARA: 'Bukhara',
};

function billingPageLabel(account?: any) {
  const key = String(account || '').trim().toUpperCase();
  return BILLING_PAGE_LABELS[key] || null;
}

function billingPageFromRecord(record?: any) {
  if (!record) return null;
  return billingPageLabel(record._account) || billingPageLabel(record.source_account);
}

function firmTitle(name: string, ...records: any[]) {
  for (const record of records) {
    const city = billingPageFromRecord(record);
    if (city) return `${name} (${city})`;
  }
  return name;
}

function formatWithExpiry(formatted?: any, dateValue?: any) {
  if (isWithinLastThreeMonths(dateValue)) {
    return formatted;
  }
  return `${EXPIRED_MESSAGE}\n\n${formatted}`;
}

function formatPartnerAccount(account: any) {
  return [
    field('🔑', 'Аккаунт', account.api_login || '-'),
    field('✅', 'Статус', account.status || '-'),
    field('🖥', 'Сервер API', account.api_server || '-'),
    field('📦', 'Тариф', account.tariff || '-'),
    field('📆', 'Оплачено до', account.paid_until || '-'),
    field('🤝', 'Создавший партнёр', account.dealer_create || '-'),
    field('📅', 'Создан', account.date_create || '-'),
  ].join('\n');
}

function formatPartner(partner: any, account: any = null) {
  const accounts = (Array.isArray(account) ? account : account ? [account] : []).filter(Boolean);
  const lines = [
    `🏢 ${bold(firmTitle('REGOS', partner, accounts[0]))}`,
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
  for (const item of accounts) {
    lines.push('');
    lines.push(formatPartnerAccount(item));
  }
  return lines.join('\n');
}

function formatRposClient(client?: any) {
  return [
    `🖥️ ${bold(firmTitle('RPOS', client))}`,
    field('🆔', 'ID', client.id),
    field('👤', 'Имя', client.name),
    field('📞', 'Телефон', client.phone || '-'),
    field('🔑', 'Код', '-'),
    field('📅', 'Создано', client.created_at || '-'),
    field('📡', 'Источник', 'RPOS'),
  ].join('\n');
}

function formatRposAccount(account?: any) {
  return [
    `🖥️ ${bold(firmTitle('RPOS', account))}`,
    field('🆔', 'ID', account.id),
    field('👤', 'Имя', account.client_name || '-'),
    field('📞', 'Телефон', '-'),
    field('🔑', 'Код', account.code || '-'),
    field('📅', 'Создано', account.created_at || '-'),
    field('📡', 'Источник', 'RPOS'),
  ].join('\n');
}

function formatLicense(license?: any) {
  return [
    `🧾 ${bold(firmTitle('EasyTrade', license))}`,
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

function formatVcr1Partner(partner?: any) {
  return [
    `📟 ${bold(firmTitle('VCR', partner))}`,
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

function formatVcr1License(license: any, partner: any = null) {
  return [
    `📟 ${bold(firmTitle('VCR', license, partner))}`,
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

function normalizeName(value?: any) {
  return String(value || '')
    .toLowerCase()
    .replace(/["«»„“”']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractInnFromPartnerLabel(value?: any) {
  const match = String(value || '').match(/\((\d{9,14})\)\s*$/);
  return match ? match[1] : null;
}

function partnerLabelWithoutInn(value?: any) {
  return normalizeName(String(value || '').replace(/\(\d{9,14}\)\s*$/, ''));
}

function namesLooselyMatch(left?: any, right?: any) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function vcr1LicenseMatchesPartner(license?: any, partner?: any) {
  if (!license || !partner) return false;

  const inn = extractInnFromPartnerLabel(license.partner);
  if (inn && String(partner.inn || '').trim() === inn) return true;

  const target = partnerLabelWithoutInn(license.partner);
  return (
    namesLooselyMatch(partner.name, target) || namesLooselyMatch(partner.company, target)
  );
}

async function findVcr1PartnerForLicense(license: any, preferredPhone: any = null) {
  const partnerLabel = license?.partner;
  if (!partnerLabel && !preferredPhone) return null;

  const searches: any[] = [];
  if (preferredPhone) searches.push(normalizePhone(preferredPhone).slice(-9));
  const inn = extractInnFromPartnerLabel(partnerLabel);
  if (inn) searches.push(inn);
  const namePart = partnerLabelWithoutInn(partnerLabel);
  if (namePart) searches.push(namePart.split(' ').slice(0, 3).join(' '));

  const partners: any[] = [];
  for (const term of searches.filter(Boolean)) {
    const found = await liveSearchVcr1Partners(term);
    partners.push(...found);
  }

  const unique: any[] = [];
  const seen: Set<any> = new Set();
  for (const partner of partners) {
    const key = String(partner.id);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(partner);
  }

  if (preferredPhone) {
    const byPhone = unique.find((partner?: any) => phonesMatch(partner.phone, preferredPhone));
    if (byPhone) return byPhone;
  }

  if (inn) {
    const byInn = unique.find((partner?: any) => String(partner.inn || '').trim() === inn);
    if (byInn) return byInn;
  }

  const target = partnerLabelWithoutInn(partnerLabel);
  if (!target) return null;

  return (
    unique.find(
      (partner?: any) =>
        namesLooselyMatch(partner.name, target) || namesLooselyMatch(partner.company, target)
    ) ?? null
  );
}

async function resolveVcr1LicenseSupportDate(license: any, preferredPhone: any = null) {
  const partner = await findVcr1PartnerForLicense(license, preferredPhone);
  return partner ? partner.registered_at : null;
}

function stripExpiredSupportBanner(message?: any) {
  let updated = String(message || '');
  const expiredPrefix = `${EXPIRED_MESSAGE}\n\n`;
  if (updated.startsWith(expiredPrefix)) {
    updated = updated.slice(expiredPrefix.length);
  } else if (updated === EXPIRED_MESSAGE) {
    updated = '';
  }
  return updated;
}

function applyVipToMessage(message: any, phone: any, vipClients: any = loadVipClients()) {
  if (!isVipClient(phone, vipClients)) {
    return message;
  }

  const updated = stripExpiredSupportBanner(message);
  return updated ? `${updated}\n\n${VIP_LABEL}` : VIP_LABEL;
}

function applyTechnicalSupportToMessage(message: any, phone: any, db: Db) {
  if (!db || !phone) return message;
  const subscription = getActiveTechnicalSupportSubscription(db, phone);
  if (!subscription) return message;

  const label = formatSupportUntilLabel(subscription.ends_at);
  const withoutExpired = stripExpiredSupportBanner(message);
  if (!label) return withoutExpired;
  const [title, ...rest] = label.split('\n');
  const badge = [`🛠 ${bold(title)}`, ...rest].join('\n');
  return withoutExpired ? `${withoutExpired}\n\n${badge}` : badge;
}

function buildSearchResult(results: any, db: Db = null!) {
  if (results.length === 0) {
    return { found: false, message: 'Не найдено' };
  }

  const vipClients = loadVipClients();
  const finalized = results.map((entry?: any) => {
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
    message: finalized.map((entry?: any) => entry.message).join('\n\n---\n\n'),
    results: finalized,
  };
}

function portalErrorResult(err: Error) {
  console.error('Live portal search failed:', err?.message || err);
  return { found: false, message: PORTAL_ERROR_MESSAGE, error: true };
}

function takeLimited(rows: any, limit: any = TEXT_SEARCH_LIMIT) {
  return (rows || []).slice(0, limit);
}

export {
  THREE_MONTHS_MS,
  EXPIRED_MESSAGE,
  PORTAL_ERROR_MESSAGE,
  TEXT_SEARCH_MIN_LENGTH,
  TEXT_SEARCH_LIMIT,
  RUSSIAN_MONTHS,
  parseRegosDate,
  isWithinLastThreeMonths,
  normalizePhone,
  normalizeQuery,
  looksLikePhone,
  looksLikeInn,
  phonesMatch,
  formatWithExpiry,
  formatPartner,
  formatRposClient,
  formatRposAccount,
  formatLicense,
  formatVcr1Partner,
  formatVcr1License,
  normalizeName,
  extractInnFromPartnerLabel,
  partnerLabelWithoutInn,
  namesLooselyMatch,
  vcr1LicenseMatchesPartner,
  findVcr1PartnerForLicense,
  resolveVcr1LicenseSupportDate,
  stripExpiredSupportBanner,
  applyVipToMessage,
  applyTechnicalSupportToMessage,
  buildSearchResult,
  portalErrorResult,
  takeLimited,
};
