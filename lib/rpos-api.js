const { RPOS_BASE_URL } = require('./rpos-auth');
const { scrapeAdminTable, hasNextAdminPage, buildPageUrl } = require('./rpos-scraper');

const CLIENTS_URL = `${RPOS_BASE_URL}/admin/license/client/`;
const ACCOUNTS_URL = `${RPOS_BASE_URL}/admin/license/account/`;

function rposClientFromRow(cells, sourceAccount) {
  return {
    id: Number(cells[0]),
    name: cells[1] ?? '',
    phone: cells[2] || null,
    created_at: cells[4] || null,
    source_account: sourceAccount,
  };
}

function rposAccountFromRow(cells, sourceAccount) {
  return {
    id: Number(cells[0]),
    code: cells[1] || null,
    client_name: cells[2] || null,
    created_at: cells[5] || null,
    source_account: sourceAccount,
  };
}

async function fetchAdminListPage(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

  if (page.url().includes('/login')) {
    throw new Error(`RPOS session expired while loading ${url}`);
  }

  return scrapeAdminTable(page);
}

async function fetchAllAdminPages(page, baseUrl, { mapRow, onPage } = {}) {
  const allRows = [];
  let pageNumber = 1;
  let pagesFetched = 0;
  let totalListed = null;

  while (true) {
    pagesFetched += 1;
    const url = buildPageUrl(baseUrl, pageNumber);
    const { rows } = await fetchAdminListPage(page, url);

    if (rows.length === 0) break;

    const mapped = rows.map((cells) => mapRow(cells));
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

async function fetchAllRposClients(page, { sourceAccount, onPage } = {}) {
  return fetchAllAdminPages(page, CLIENTS_URL, {
    mapRow: (cells) => rposClientFromRow(cells, sourceAccount),
    onPage,
  });
}

async function fetchAllRposAccounts(page, { sourceAccount, onPage } = {}) {
  return fetchAllAdminPages(page, ACCOUNTS_URL, {
    mapRow: (cells) => rposAccountFromRow(cells, sourceAccount),
    onPage,
  });
}

module.exports = {
  CLIENTS_URL,
  ACCOUNTS_URL,
  rposClientFromRow,
  rposAccountFromRow,
  fetchAllRposClients,
  fetchAllRposAccounts,
};
