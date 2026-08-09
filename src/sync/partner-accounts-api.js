const PARTNER_ACCOUNTS_GET_URL = 'https://sb.regos.uz/PartnerAccounts/Get';
const DEFAULT_PAGE_SIZE = 100;
const LIVE_PAGE_SIZE = 50;
const DEFAULT_ACCOUNT_STATUS = 5;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const PARTNER_ACCOUNTS_REFERER = 'https://sb.regos.uz/PartnerAccounts/Index';

function regosAjaxHeaders(referer) {
  return {
    Referer: referer,
    'X-Requested-With': 'XMLHttpRequest',
  };
}

const COLUMNS = [
  'partner',
  'status',
  'api_server',
  'api_login',
  'tariff',
  'paid_until',
  'dealer_create',
  'date_create',
  'dealer',
  'id',
];
const ORDERABLE = [true, true, true, false, true, false, true, true, false, false];

function buildFormData({
  draw,
  start,
  length,
  accountStatus = DEFAULT_ACCOUNT_STATUS,
  search = '',
}) {
  const form = {
    draw: String(draw),
    start: String(start),
    length: String(length),
    'search[value]': String(search || ''),
    'search[regex]': 'false',
    'order[0][column]': '7',
    'order[0][dir]': 'desc',
    additionalproperty: JSON.stringify([{ name: 'account_status', value: String(accountStatus) }]),
  };

  COLUMNS.forEach((data, index) => {
    form[`columns[${index}][data]`] = data;
    form[`columns[${index}][name]`] = '';
    form[`columns[${index}][searchable]`] = 'true';
    form[`columns[${index}][orderable]`] = String(ORDERABLE[index]);
    form[`columns[${index}][search][value]`] = '';
    form[`columns[${index}][search][regex]`] = 'false';
  });

  return form;
}

async function fetchPartnerAccountsPage(
  request,
  {
    start = 0,
    length = DEFAULT_PAGE_SIZE,
    draw = 1,
    accountStatus = DEFAULT_ACCOUNT_STATUS,
    search = '',
  } = {}
) {
  const response = await request.post(PARTNER_ACCOUNTS_GET_URL, {
    form: buildFormData({ draw, start, length, accountStatus, search }),
    headers: regosAjaxHeaders(PARTNER_ACCOUNTS_REFERER),
    timeout: DEFAULT_REQUEST_TIMEOUT_MS,
  });

  if (!response.ok()) {
    throw new Error(`PartnerAccounts/Get failed with status ${response.status()}`);
  }

  const text = await response.text();
  if (text.trimStart().startsWith('<!')) {
    throw new Error('PartnerAccounts/Get returned login/HTML (session expired)');
  }
  return JSON.parse(text);
}

async function searchPartnerAccounts(
  request,
  search,
  { pageSize = LIVE_PAGE_SIZE, accountStatus = DEFAULT_ACCOUNT_STATUS } = {}
) {
  const payload = await fetchPartnerAccountsPage(request, {
    start: 0,
    length: pageSize,
    draw: 1,
    accountStatus,
    search: search || '',
  });
  return {
    rows: payload.data ?? [],
    total: payload.recordsFiltered ?? payload.recordsTotal ?? 0,
  };
}

async function fetchAllPartnerAccounts(
  request,
  {
    pageSize = DEFAULT_PAGE_SIZE,
    accountStatus = DEFAULT_ACCOUNT_STATUS,
    onPage,
    search = '',
  } = {}
) {
  const first = await fetchPartnerAccountsPage(request, {
    start: 0,
    length: pageSize,
    draw: 1,
    accountStatus,
    search,
  });
  const total = first.recordsFiltered ?? first.recordsTotal ?? first.data?.length ?? 0;
  const allRows = [...(first.data ?? [])];

  if (onPage) {
    onPage({ page: 1, fetched: allRows.length, total });
  }

  let start = pageSize;
  let draw = 2;
  let pagesFetched = 1;

  while (start < total) {
    pagesFetched += 1;
    const next = await fetchPartnerAccountsPage(request, {
      start,
      length: pageSize,
      draw,
      accountStatus,
      search,
    });
    const batch = next.data ?? [];
    if (batch.length === 0) break;

    allRows.push(...batch);
    if (onPage) {
      onPage({ page: pagesFetched, fetched: allRows.length, total });
    }

    start += pageSize;
    draw += 1;
  }

  return { rows: allRows, total, pages: pagesFetched };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  LIVE_PAGE_SIZE,
  DEFAULT_ACCOUNT_STATUS,
  fetchAllPartnerAccounts,
  fetchPartnerAccountsPage,
  searchPartnerAccounts,
};
