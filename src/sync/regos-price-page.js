const https = require('https');
const http = require('http');
const { isRedisConfigured, getRedisClient } = require('../sms/redis-client');

const PRICE_PAGE_URL = 'https://regos.uz/ru/price';
const REDIS_KEY = 'regos:price:ru';
const DEFAULT_TTL_SEC = 7 * 24 * 60 * 60;
const DEFAULT_TIMEOUT_MS = 30000;

/** @type {Promise<unknown> | null} */
let inFlight = null;

const LIMIT_ROW_KEYS = [
  { match: /количество предприятий/i, key: 'enterprises' },
  { match: /количество складов/i, key: 'warehouses' },
  { match: /количество касс/i, key: 'cashRegisters' },
  { match: /количество пользователей/i, key: 'users' },
  { match: /место на диске/i, key: 'diskMb' },
  { match: /период отображения данных/i, key: 'dataMonths' },
];

const EXTRA_NAME_KEYS = [
  { match: /доп\.\s*предприятие/i, key: 'enterprises', unit: 1 },
  { match: /доп\.\s*склад/i, key: 'warehouses', unit: 1 },
  { match: /доп\.\s*касса/i, key: 'cashRegisters', unit: 1 },
  { match: /доп\.\s*пользователь/i, key: 'users', unit: 1 },
  { match: /доп\.\s*место на диске/i, key: 'diskMb', unit: 512 },
  { match: /доп\.\s*период отображения/i, key: 'dataMonths', unit: 6 },
];

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function getPriceCacheTtlSec() {
  return parsePositiveInt(process.env.REGOS_PRICE_CACHE_TTL_SEC, DEFAULT_TTL_SEC);
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

function stripTags(html) {
  return decodeHtmlEntities(String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}

function parseMoneyAmount(text) {
  const digits = String(text || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

function parseIncludedValue(text, key) {
  const raw = stripTags(text);
  if (!raw) return null;
  if (key === 'diskMb') {
    const mb = raw.match(/([\d\s]+)\s*мб/i);
    if (mb) return parseMoneyAmount(mb[1]);
  }
  if (key === 'dataMonths') {
    const months = raw.match(/([\d\s]+)\s*мес/i);
    if (months) return parseMoneyAmount(months[1]);
  }
  return parseMoneyAmount(raw);
}

function fetchUrlText(url, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'ScrapRegosUserBot/1.0',
        },
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode || 0) >= 400) {
            reject(new Error(`regos price page failed with status ${res.statusCode}`));
            return;
          }
          resolve(body);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${timeout}ms`)));
    req.on('error', reject);
    req.end();
  });
}

function parsePlanHeaders(theadHtml) {
  const ths = [...String(theadHtml || '').matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)];
  // First th is empty corner cell.
  const plans = [];
  for (let i = 1; i < ths.length; i += 1) {
    const cell = ths[i][1];
    const nameMatch = cell.match(/<strong>\s*([^<]+)\s*<\/strong>/i);
    const name = nameMatch ? stripTags(nameMatch[1]) : null;
    if (!name) continue;

    const amounts = [...cell.matchAll(
      /<span class="price-matrix__amount">\s*([^<]+)\s*<\/span>[\s\S]*?<span class="price-matrix__note">\s*([^<]+)\s*<\/span>/gi
    )];

    let monthlyPrice = null;
    let yearlyMonthlyPrice = null;
    for (const amountMatch of amounts) {
      const amount = parseMoneyAmount(amountMatch[1]);
      const note = stripTags(amountMatch[2]).toLowerCase();
      if (note.includes('месяц')) monthlyPrice = amount;
      else if (note.includes('год')) yearlyMonthlyPrice = amount;
    }
    if (monthlyPrice == null && amounts[0]) {
      monthlyPrice = parseMoneyAmount(amounts[0][1]);
    }

    plans.push({
      name,
      monthlyPrice,
      yearlyMonthlyPrice,
    });
  }
  return plans;
}

function parseLimitRows(tbodyHtml, planCount) {
  const includedByPlan = Array.from({ length: planCount }, () => ({}));
  const rows = [...String(tbodyHtml || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  for (const row of rows) {
    const th = row[1].match(/<th\b[^>]*>([\s\S]*?)<\/th>/i);
    if (!th) continue;
    const label = stripTags(th[1]);
    const keyInfo = LIMIT_ROW_KEYS.find((item) => item.match.test(label));
    if (!keyInfo) continue;

    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)];
    for (let i = 0; i < planCount && i < cells.length; i += 1) {
      includedByPlan[i][keyInfo.key] = parseIncludedValue(cells[i][1], keyInfo.key);
    }
  }
  return includedByPlan;
}

function parseExtras(html) {
  const tableMatch = String(html || '').match(/<table[^>]*class="[^"]*price-table[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return {};

  const extras = {};
  const rows = [...tableMatch[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  for (const row of rows) {
    if (/price-table__category/i.test(row[0])) continue;
    const nameMatch = row[1].match(/price-table__name[^>]*>([\s\S]*?)<\/td>/i);
    if (!nameMatch) continue;
    const name = stripTags(nameMatch[1]);
    const keyInfo = EXTRA_NAME_KEYS.find((item) => item.match.test(name));
    if (!keyInfo) continue;

    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)];
    // name, connect, period
    const periodText = cells[2] ? stripTags(cells[2][1]) : '';
    const periodPrice = parseMoneyAmount(periodText);
    if (periodPrice == null) continue;
    extras[keyInfo.key] = {
      name,
      periodPrice,
      unitSize: keyInfo.unit,
    };
  }
  return extras;
}

/**
 * Parse https://regos.uz/ru/price HTML into a structured catalog.
 * @param {string} html
 */
function parseRegosPricePage(html) {
  const matrixMatch = String(html || '').match(
    /<table[^>]*class="[^"]*price-matrix[^"]*"[^>]*>([\s\S]*?)<\/table>/i
  );
  if (!matrixMatch) {
    throw new Error('regos price page: price-matrix table not found');
  }

  const theadMatch = matrixMatch[1].match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
  const tbodyMatch = matrixMatch[1].match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  const planHeaders = parsePlanHeaders(theadMatch ? theadMatch[1] : '');
  if (!planHeaders.length) {
    throw new Error('regos price page: no tariff plans found');
  }

  const includedByPlan = parseLimitRows(tbodyMatch ? tbodyMatch[1] : '', planHeaders.length);
  const plans = {};
  for (let i = 0; i < planHeaders.length; i += 1) {
    const header = planHeaders[i];
    plans[header.name] = {
      name: header.name,
      monthlyPrice: header.monthlyPrice,
      yearlyMonthlyPrice: header.yearlyMonthlyPrice,
      included: includedByPlan[i] || {},
    };
  }

  return {
    fetchedAt: new Date().toISOString(),
    sourceUrl: PRICE_PAGE_URL,
    plans,
    extras: parseExtras(html),
  };
}

async function readPriceCache() {
  try {
    if (!isRedisConfigured()) return null;
    const redis = getRedisClient();
    if (!redis) return null;
    const raw = await redis.get(REDIS_KEY);
    if (raw == null) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error('[regos-price] redis get failed:', err.message || err);
    return null;
  }
}

async function writePriceCache(catalog, ttlSec) {
  try {
    if (!isRedisConfigured()) return;
    const redis = getRedisClient();
    if (!redis) return;
    await redis.set(REDIS_KEY, JSON.stringify(catalog), 'EX', ttlSec);
  } catch (err) {
    console.error('[regos-price] redis set failed:', err.message || err);
  }
}

async function fetchAndParsePriceCatalog() {
  const html = await fetchUrlText(PRICE_PAGE_URL);
  return parseRegosPricePage(html);
}

/**
 * Long-TTL Redis-cached price catalog. Fail-open on Redis errors.
 */
async function getRegosPriceCatalog({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = await readPriceCache();
    if (cached?.plans) return cached;
  }

  if (inFlight) return inFlight;

  inFlight = (async () => {
    const catalog = await fetchAndParsePriceCatalog();
    await writePriceCache(catalog, getPriceCacheTtlSec());
    return catalog;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

function findPlan(catalog, tariffName) {
  const name = String(tariffName || '').trim();
  if (!name || !catalog?.plans) return null;
  if (catalog.plans[name]) return catalog.plans[name];
  const lower = name.toLowerCase();
  for (const [key, plan] of Object.entries(catalog.plans)) {
    if (key.toLowerCase() === lower) return plan;
  }
  return null;
}

function extraUnits(total, included, unitSize) {
  const over = Math.max(0, Number(total) - Number(included));
  if (!Number.isFinite(over) || over <= 0) return 0;
  const size = unitSize > 0 ? unitSize : 1;
  return Math.ceil(over / size);
}

/**
 * Calculate monthly total from price catalog + portal limits (Всего).
 * @param {{ tariffName: string, limits: Array<{ key?: string, total?: number|null, included?: number|null }> }} input
 * @param {object} catalog
 */
function calculateTariffMonthlyTotal(input, catalog) {
  const plan = findPlan(catalog, input?.tariffName);
  if (!plan || plan.monthlyPrice == null) {
    return {
      ok: false,
      reason: plan ? 'missing_monthly_price' : 'unknown_tariff',
      total: null,
      base: null,
      extrasTotal: null,
      lines: [],
    };
  }

  const lines = [
    {
      key: 'base',
      label: `Тариф ${plan.name}`,
      quantity: 1,
      unitPrice: plan.monthlyPrice,
      amount: plan.monthlyPrice,
    },
  ];

  let extrasTotal = 0;
  const limits = Array.isArray(input?.limits) ? input.limits : [];

  for (const [key, extra] of Object.entries(catalog.extras || {})) {
    const limit = limits.find((row) => row.key === key);
    if (!limit) continue;

    const includedFromPlan = plan.included?.[key];
    const included =
      includedFromPlan != null && Number.isFinite(Number(includedFromPlan))
        ? Number(includedFromPlan)
        : Number(limit.included);
    const total = Number(limit.total);
    if (!Number.isFinite(total) || !Number.isFinite(included)) continue;

    const qty = extraUnits(total, included, extra.unitSize || 1);
    if (qty <= 0) continue;

    const amount = qty * extra.periodPrice;
    extrasTotal += amount;
    lines.push({
      key,
      label: extra.name,
      quantity: qty,
      unitPrice: extra.periodPrice,
      amount,
    });
  }

  return {
    ok: true,
    reason: null,
    total: plan.monthlyPrice + extrasTotal,
    base: plan.monthlyPrice,
    extrasTotal,
    lines,
    planName: plan.name,
  };
}

module.exports = {
  PRICE_PAGE_URL,
  REDIS_KEY,
  DEFAULT_TTL_SEC,
  getPriceCacheTtlSec,
  parseMoneyAmount,
  parseRegosPricePage,
  getRegosPriceCatalog,
  findPlan,
  calculateTariffMonthlyTotal,
  extraUnits,
};
