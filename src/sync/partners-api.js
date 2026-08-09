const PARTNERS_GET_URL = 'https://sb.regos.uz/Partners/Get';
const DEFAULT_PAGE_SIZE = 100;
const LIVE_PAGE_SIZE = 50;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const PARTNERS_REFERER = 'https://sb.regos.uz/Partners/Index';

function regosAjaxHeaders(referer) {
  return {
    Referer: referer,
    'X-Requested-With': 'XMLHttpRequest',
  };
}

function buildFormData({ draw, start, length, search = '' }) {
  const form = {
    draw: String(draw),
    start: String(start),
    length: String(length),
    'search[value]': String(search || ''),
    'search[regex]': 'false',
    'order[0][column]': '0',
    'order[0][dir]': 'desc',
  };

  const columns = [
    'id',
    'name',
    'legal_status',
    'phone',
    'contacts',
    'description',
    'status',
    'balance',
    'create_date',
    'id',
  ];
  columns.forEach((data, index) => {
    form[`columns[${index}][data]`] = data;
    form[`columns[${index}][name]`] = '';
    form[`columns[${index}][searchable]`] = 'true';
    form[`columns[${index}][orderable]`] = String(index < 8);
    form[`columns[${index}][search][value]`] = '';
    form[`columns[${index}][search][regex]`] = 'false';
  });

  return form;
}

async function fetchPartnersPage(
  request,
  { start = 0, length = DEFAULT_PAGE_SIZE, draw = 1, search = '' } = {}
) {
  const response = await request.post(PARTNERS_GET_URL, {
    form: buildFormData({ draw, start, length, search }),
    headers: regosAjaxHeaders(PARTNERS_REFERER),
    timeout: DEFAULT_REQUEST_TIMEOUT_MS,
  });

  if (!response.ok()) {
    throw new Error(`Partners/Get failed with status ${response.status()}`);
  }

  const text = await response.text();
  if (text.trimStart().startsWith('<!')) {
    throw new Error('Partners/Get returned login/HTML (session expired)');
  }
  return JSON.parse(text);
}

async function searchPartners(request, search, { pageSize = LIVE_PAGE_SIZE } = {}) {
  const payload = await fetchPartnersPage(request, {
    start: 0,
    length: pageSize,
    draw: 1,
    search: search || '',
  });
  return {
    rows: payload.data ?? [],
    total: payload.recordsFiltered ?? payload.recordsTotal ?? 0,
  };
}

async function fetchAllPartners(request, { pageSize = DEFAULT_PAGE_SIZE, onPage, search = '' } = {}) {
  const first = await fetchPartnersPage(request, { start: 0, length: pageSize, draw: 1, search });
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
    const next = await fetchPartnersPage(request, { start, length: pageSize, draw, search });
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
  fetchAllPartners,
  fetchPartnersPage,
  searchPartners,
};
