const PARTNER_ACCOUNTS_DETAIL_URL = 'https://sb.regos.uz/PartnerAccounts/Detail';
const PARTNER_ACCOUNTS_REFERER = 'https://sb.regos.uz/PartnerAccounts/Index';
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

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

function parseNumberish(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '-' || raw === '—') return null;
  const normalized = raw.replace(/\s/g, '').replace(',', '.');
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

function extractKpi(html, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `account-kpi-title[^>]*>\\s*${escaped}\\s*<\\/span>\\s*<div[^>]*account-kpi-value[^>]*>([\\s\\S]*?)<\\/div>`,
    'i'
  );
  const match = String(html || '').match(re);
  if (!match) return null;
  return stripTags(match[1]) || null;
}

function extractLabeledControl(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `<label>\\s*<strong>\\s*${escaped}\\s*<\\/strong>\\s*<\\/label>\\s*<label[^>]*class="[^"]*form-control[^"]*"[^>]*>([\\s\\S]*?)<\\/label>`,
    'i'
  );
  const match = String(html || '').match(re);
  if (!match) return null;
  return stripTags(match[1]) || null;
}

function classifyLimitKey(name) {
  const text = String(name || '').toLowerCase();
  if (text.includes('предприят')) return 'enterprises';
  if (text.includes('склад')) return 'warehouses';
  if (text.includes('касс')) return 'cashRegisters';
  if (text.includes('пользовател')) return 'users';
  if (text.includes('диске') || text.includes('диск')) return 'diskMb';
  if (text.includes('период') || text.includes('отображен')) return 'dataMonths';
  return null;
}

function parseLimitBlock(blockHtml) {
  const nameMatch = String(blockHtml || '').match(
    /^\s*([^:<][^:]*?)\s*:?\s*<div/i
  );
  const name = nameMatch ? stripTags(nameMatch[1]).replace(/:$/, '').trim() : null;
  if (!name) return null;

  const totalMatch = blockHtml.match(/Всего:\s*(?:<b>)?\s*([^<]+)\s*(?:<\/b>)?/i);
  const includedMatch = blockHtml.match(/По тарифу:\s*([^<]+)/i);
  const actualMatch = blockHtml.match(/Фактически:\s*(?:<b>)?\s*([^<]+)\s*(?:<\/b>)?/i);

  const totalRaw = totalMatch ? stripTags(totalMatch[1]) : null;
  const includedRaw = includedMatch ? stripTags(includedMatch[1]) : null;
  const actualRaw = actualMatch ? stripTags(actualMatch[1]) : null;

  return {
    key: classifyLimitKey(name),
    name,
    total: parseNumberish(totalRaw),
    included: parseNumberish(includedRaw),
    actual: parseNumberish(actualRaw),
    totalRaw,
    includedRaw,
    actualRaw,
  };
}

function extractLimitsSection(html) {
  const marker = String(html || '').search(/Лимиты тарифа/i);
  if (marker < 0) return '';

  const formControl = html.indexOf('class="form-control"', marker);
  if (formControl < 0) return '';

  const openDiv = html.lastIndexOf('<div', formControl);
  if (openDiv < 0) return '';

  let depth = 0;
  let i = openDiv;
  while (i < html.length) {
    const nextOpen = html.indexOf('<div', i);
    const nextClose = html.indexOf('</div>', i);
    if (nextClose < 0) break;

    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen + 4;
      continue;
    }

    depth -= 1;
    i = nextClose + 6;
    if (depth === 0) {
      return html.slice(openDiv, i);
    }
  }
  return html.slice(openDiv);
}

function parseTariffLimits(html) {
  const section = extractLimitsSection(html);
  if (!section) return [];

  const blocks = [...section.matchAll(/<div style="padding-bottom:\s*5px;">([\s\S]*?)<\/div>\s*<\/div>/gi)];
  const limits = [];
  for (const block of blocks) {
    const parsed = parseLimitBlock(block[1]);
    if (parsed) limits.push(parsed);
  }
  return limits;
}

/**
 * Parse PartnerAccounts Detail overview tab fields.
 * @param {string} html
 */
function parsePartnerAccountOverview(html) {
  // Portal encodes Cyrillic as numeric entities in many builds.
  const body = decodeHtmlEntities(String(html || ''));
  return {
    status: extractKpi(body, 'Статус'),
    usedLimit: extractKpi(body, 'Используемый лимит'),
    tariffCost: extractKpi(body, 'Стоимость тарифа'),
    paidUntil: extractKpi(body, 'Оплачено до'),
    tariff: extractLabeledControl(body, 'Тариф'),
    limits: parseTariffLimits(body),
  };
}

async function fetchPartnerAccountDetail(request, id, { timeout = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const accountId = String(id ?? '').trim();
  if (!accountId) {
    throw new Error('PartnerAccounts/Detail requires id');
  }

  const url = `${PARTNER_ACCOUNTS_DETAIL_URL}/${encodeURIComponent(accountId)}`;
  const response = await request.get(url, {
    headers: {
      Referer: PARTNER_ACCOUNTS_REFERER,
      Accept: 'text/html,application/xhtml+xml',
    },
    timeout,
  });

  if (!response.ok()) {
    throw new Error(`PartnerAccounts/Detail failed with status ${response.status()}`);
  }

  const text = await response.text();
  if (/войти через regos/i.test(text) && /account\/login/i.test(text)) {
    throw new Error('PartnerAccounts/Detail returned login/HTML (session expired)');
  }

  return text;
}

module.exports = {
  PARTNER_ACCOUNTS_DETAIL_URL,
  decodeHtmlEntities,
  stripTags,
  parseNumberish,
  classifyLimitKey,
  parsePartnerAccountOverview,
  fetchPartnerAccountDetail,
};
