const { VCR1_BASE_URL } = require('./regos-auth');

const PARTNERS_GET_URL = `${VCR1_BASE_URL}/Partners/Get`;
const PARTNERS_REFERER = `${VCR1_BASE_URL}/Partners/Index`;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

const COLUMNS = ['id', 'name', 'inn', 'phone', 'contacts', 'company', 'balance', 'id'];
const ORDERABLE = [true, true, true, false, false, true, false, false];

function vcr1AjaxHeaders(referer) {
  return {
    Referer: referer,
    'X-Requested-With': 'XMLHttpRequest',
  };
}

function buildFormData({ draw, start, length }) {
  const form = {
    draw: String(draw),
    start: String(start),
    length: String(length),
    'search[value]': '',
    'search[regex]': 'false',
    'order[0][column]': '0',
    'order[0][dir]': 'DESC',
    'additionalproperty[0][name]': 'legal_status',
    'additionalproperty[1][name]': 'company',
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

function assertPartnersResponse(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('vcr1 Partners/Get returned a non-object response');
  }
  if (!Array.isArray(payload.data)) {
    throw new Error('vcr1 Partners/Get response missing data[]');
  }
  return payload;
}

async function fetchVcr1PartnersPage(request, { start = 0, length = DEFAULT_PAGE_SIZE, draw = 1 } = {}) {
  const response = await request.post(PARTNERS_GET_URL, {
    form: buildFormData({ draw, start, length }),
    headers: vcr1AjaxHeaders(PARTNERS_REFERER),
    timeout: DEFAULT_REQUEST_TIMEOUT_MS,
  });

  if (!response.ok()) {
    throw new Error(`vcr1 Partners/Get failed with status ${response.status()}`);
  }

  return assertPartnersResponse(await response.json());
}

async function fetchAllVcr1Partners(request, { pageSize = DEFAULT_PAGE_SIZE, onPage } = {}) {
  const first = await fetchVcr1PartnersPage(request, { start: 0, length: pageSize, draw: 1 });
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
    const next = await fetchVcr1PartnersPage(request, { start, length: pageSize, draw });
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
  fetchAllVcr1Partners,
  fetchVcr1PartnersPage,
};
