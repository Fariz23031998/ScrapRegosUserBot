const net = require('net');
const { stripTags } = require('../../sync/rpos-html');

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_TEXT = 8000;
const MAX_SEARCH_RESULTS = 8;
const USER_AGENT = 'ScrapRegosUserBot/1.0';
const DDG_SEARCH_URL = 'https://html.duckduckgo.com/html/';

const REGOS_PORTAL_HOSTS = new Set(['sb.regos.uz', 'vcr1.regos.uz', 'my.easytrade.uz']);
const RPOS_PORTAL_HOSTS = new Set(['api.chayxanshik.uz']);

function isBrowseEnabled() {
  const raw = String(process.env.AI_BROWSE_ENABLED || '').trim().toLowerCase();
  if (!raw) return true;
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

function getBrowseTimeoutMs() {
  const n = Number(process.env.AI_BROWSE_TIMEOUT_MS);
  if (Number.isFinite(n) && n >= 1000) return Math.min(Math.floor(n), 30_000);
  return DEFAULT_TIMEOUT_MS;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const normalized = String(ip || '').toLowerCase();
    if (normalized === '::1') return true;
    if (normalized.startsWith('fe80:')) return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('::ffff:')) {
      const v4 = normalized.slice('::ffff:'.length);
      if (net.isIPv4(v4)) return isPrivateIp(v4);
    }
    return false;
  }
  return true;
}

function hostnameIsPrivate(hostname) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return true;
  if (host === '::1' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (net.isIP(host)) return isPrivateIp(host);
  return false;
}

function assertSafeBrowseUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new Error('INVALID_URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('INVALID_URL');
  }
  if (hostnameIsPrivate(url.hostname)) {
    throw new Error('BLOCKED_URL');
  }
  return url;
}

function classifyBrowseHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (REGOS_PORTAL_HOSTS.has(host)) return 'regos';
  if (RPOS_PORTAL_HOSTS.has(host)) return 'rpos';
  return 'public';
}

function htmlToText(html) {
  const withoutNoise = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  const titleMatch = withoutNoise.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : '';
  return {
    title: title || null,
    text: stripTags(withoutNoise).slice(0, MAX_TEXT),
  };
}

function decodeHref(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function unwrapDuckDuckGoUrl(href) {
  try {
    const url = new URL(decodeHref(href), 'https://duckduckgo.com');
    const uddg = url.searchParams.get('uddg');
    if (uddg) return uddg;
    return url.toString();
  } catch {
    return String(href || '').trim();
  }
}

function parseDuckDuckGoResults(html) {
  const results = [];
  const seen = new Set();
  const snippets = [...String(html || '').matchAll(/<[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi)].map(
    (match) => stripTags(match[1])
  );

  for (const match of String(html || '').matchAll(
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  )) {
    const url = unwrapDuckDuckGoUrl(match[1]);
    const title = stripTags(match[2]);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title,
      url,
      snippet: snippets[results.length] || '',
    });
    if (results.length >= MAX_SEARCH_RESULTS) break;
  }
  return results;
}

async function fetchPublicHtml(url, { timeoutMs = getBrowseTimeoutMs(), fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(String(url), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
      },
    });
    const html = await response.text();
    return {
      status: response.status,
      ok: Boolean(response.ok),
      finalUrl: String(response.url || url),
      html,
    };
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.message === 'BROWSE_TIMEOUT')) {
      throw new Error('BROWSE_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function mapUrlError(error) {
  if (error?.message === 'INVALID_URL') return { ok: false, error: 'invalid_url' };
  if (error?.message === 'BLOCKED_URL') return { ok: false, error: 'blocked_url' };
  if (error?.message === 'BROWSE_TIMEOUT') return { ok: false, error: 'timeout' };
  return { ok: false, error: error?.message || 'browse_failed' };
}

async function webSearch(query, deps = {}) {
  if (!isBrowseEnabled()) return { ok: false, error: 'browse_disabled' };
  const text = String(query || '').trim();
  if (!text) return { ok: false, error: 'empty_query' };

  const searchUrl = new URL(DDG_SEARCH_URL);
  searchUrl.searchParams.set('q', text);
  try {
    assertSafeBrowseUrl(searchUrl);
    const page = await fetchPublicHtml(searchUrl, deps);
    if (!page.ok) {
      return { ok: false, error: `search_failed:${page.status}`, results: [] };
    }
    return { ok: true, query: text, results: parseDuckDuckGoResults(page.html) };
  } catch (error) {
    return { ...mapUrlError(error), results: [] };
  }
}

async function browsePortalUrl(url, source, deps = {}) {
  const getAccounts = deps.getConfiguredAccounts || require('../../sync/accounts').getConfiguredAccounts;
  const hasRpos = deps.hasRposCredentials || require('../../sync/accounts').hasRposCredentials;
  const accounts = getAccounts();
  const account = accounts[0];
  if (!account) return { ok: false, error: 'no_portal_account', source };

  if (source === 'rpos' && !hasRpos(account)) {
    return { ok: false, error: 'no_rpos_credentials', source };
  }

  const withSession =
    source === 'rpos'
      ? deps.withRposSession || require('../../live/session-manager').withRposSession
      : deps.withRegosSession || require('../../live/session-manager').withRegosSession;

  const timeout = deps.timeoutMs || getBrowseTimeoutMs();
  const page = await withSession(account, async (request) => {
    const response = await request.get(url.toString(), { timeout });
    const html = await response.text();
    const finalUrl = typeof response.url === 'function' ? response.url() : url.toString();
    return {
      status: typeof response.status === 'function' ? response.status() : 0,
      ok: typeof response.ok === 'function' ? response.ok() : true,
      finalUrl,
      html,
    };
  });

  const parsed = htmlToText(page.html);
  return {
    ok: Boolean(page.ok),
    url: url.toString(),
    final_url: page.finalUrl,
    title: parsed.title,
    text: parsed.text,
    source,
    status: page.status,
  };
}

async function browseUrl(rawUrl, deps = {}) {
  if (!isBrowseEnabled()) return { ok: false, error: 'browse_disabled' };

  let url;
  try {
    url = assertSafeBrowseUrl(rawUrl);
  } catch (error) {
    return mapUrlError(error);
  }

  const source = classifyBrowseHost(url.hostname);
  try {
    if (source !== 'public') {
      return await browsePortalUrl(url, source, deps);
    }
    const page = await fetchPublicHtml(url, deps);
    const parsed = htmlToText(page.html);
    return {
      ok: page.ok,
      url: url.toString(),
      final_url: page.finalUrl,
      title: parsed.title,
      text: parsed.text,
      source,
      status: page.status,
    };
  } catch (error) {
    return { ...mapUrlError(error), source };
  }
}

function createBrowseTools({ deps = {} } = {}) {
  if (!isBrowseEnabled()) return [];

  const runSearch = deps.webSearch || ((query) => webSearch(query, deps));
  const runBrowse = deps.browseUrl || ((url) => browseUrl(url, deps));

  return [
    {
      name: 'web_search',
      description:
        'Search the public web. Returns titles, URLs, and snippets. Then use browse_url to read a page. Do not invent sources.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
      execute: async ({ query } = {}) => runSearch(query),
    },
    {
      name: 'browse_url',
      description:
        'Open a public or internal portal URL (GET only, read-only) and return page text. Use for docs, tariff pages, and portal screens. Do not create, edit, or delete anything.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http(s) URL to open' },
        },
        required: ['url'],
      },
      execute: async ({ url } = {}) => runBrowse(url),
    },
  ];
}

module.exports = {
  MAX_TEXT,
  USER_AGENT,
  isBrowseEnabled,
  assertSafeBrowseUrl,
  classifyBrowseHost,
  htmlToText,
  unwrapDuckDuckGoUrl,
  parseDuckDuckGoResults,
  webSearch,
  browseUrl,
  createBrowseTools,
};
