import type { Unchecked } from '../types/unchecked';
import { RPOS_BASE_URL } from './rpos-auth';
import { scrapeAdminTable, hasNextAdminPage, buildPageUrl } from './rpos-scraper';
import { parseAdminTableHtml, isRposLoginHtml } from './rpos-html';
import { rposClientFromRow, rposAccountFromRow } from '../live/mappers';

const CLIENTS_URL = `${RPOS_BASE_URL}/admin/license/client/`;
const ACCOUNTS_URL = `${RPOS_BASE_URL}/admin/license/account/`;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

function buildSearchUrl(baseUrl?: any, query?: any) {
  const url = new URL(baseUrl);
  if (query) url.searchParams.set('q', String(query));
  else url.searchParams.delete('q');
  return url.toString();
}

async function fetchAdminListPage(page?: any, url?: any) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

  if (page.url().includes('/login')) {
    throw new Error(`RPOS session expired while loading ${url}`);
  }

  return scrapeAdminTable(page);
}

async function fetchAllAdminPages(page: any, baseUrl: any, { mapRow, onPage }: Unchecked = {}) {
  const allRows: any[] = [];
  let pageNumber = 1;
  let pagesFetched = 0;
  let totalListed: any = null;

  while (true) {
    pagesFetched += 1;
    const url = buildPageUrl(baseUrl, pageNumber);
    const { rows } = await fetchAdminListPage(page, url);

    if (rows.length === 0) break;

    const mapped = rows.map((cells?: any) => mapRow(cells));
    allRows.push(...mapped);

    if (totalListed === null) {
      totalListed = await page.evaluate(() => {
        const paginator = document.querySelector('p.paginator');
        if (!paginator) return null;
        const text = paginator.textContent.replace(/\s+/g, ' ').trim();
        const matches = text.match(/(\d+)\s+[А-Яа-яЁё]+/g);
        if (!matches || matches.length === 0) return null;
        const last = matches[matches.length - 1].match(/^(\d+)/);
        return last ? parseInt(last[1], 10) : null;
      });
    }

    const total = totalListed ?? allRows.length;
    if (onPage) {
      onPage({ page: pagesFetched, fetched: allRows.length, total });
    }

    const hasNext = await hasNextAdminPage(page);
    if (!hasNext) break;

    pageNumber += 1;
  }

  return {
    rows: allRows,
    total: totalListed ?? allRows.length,
    pages: pagesFetched,
  };
}

async function fetchAllRposClients(page: any, { sourceAccount, onPage }: Unchecked = {}) {
  return fetchAllAdminPages(page, CLIENTS_URL, {
    mapRow: (cells?: any) => rposClientFromRow(cells, sourceAccount),
    onPage,
  });
}

async function fetchAllRposAccounts(page: any, { sourceAccount, onPage }: Unchecked = {}) {
  return fetchAllAdminPages(page, ACCOUNTS_URL, {
    mapRow: (cells?: any) => rposAccountFromRow(cells, sourceAccount),
    onPage,
  });
}

async function searchRposChangelist(request: any, baseUrl: any, query: any, { mapRow }: Unchecked = {}) {
  const url = buildSearchUrl(baseUrl, query);
  const response = await request.get(url, {
    headers: { Accept: 'text/html', Referer: baseUrl },
    timeout: DEFAULT_REQUEST_TIMEOUT_MS,
  });
  const html = await response.text();
  const finalUrl = typeof response.url === 'function' ? response.url() : url;
  if (!response.ok()) {
    throw new Error(`RPOS ${baseUrl} failed with status ${response.status()}`);
  }
  if (isRposLoginHtml(html, finalUrl)) {
    throw new Error('RPOS session expired (login page)');
  }
  const { rows } = parseAdminTableHtml(html);
  return {
    rows: rows.map((cells?: any) => mapRow(cells)),
    total: rows.length,
  };
}

async function searchRposClients(request: any, query: any, { sourceAccount }: Unchecked = {}) {
  return searchRposChangelist(request, CLIENTS_URL, query, {
    mapRow: (cells?: any) => rposClientFromRow(cells, sourceAccount),
  });
}

async function searchRposAccounts(request: any, query: any, { sourceAccount }: Unchecked = {}) {
  return searchRposChangelist(request, ACCOUNTS_URL, query, {
    mapRow: (cells?: any) => rposAccountFromRow(cells, sourceAccount),
  });
}

export {
  CLIENTS_URL,
  ACCOUNTS_URL,
  rposClientFromRow,
  rposAccountFromRow,
  fetchAllRposClients,
  fetchAllRposAccounts,
  searchRposClients,
  searchRposAccounts,
  buildSearchUrl,
};
