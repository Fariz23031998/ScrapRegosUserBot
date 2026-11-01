import type { Unchecked } from '../types/unchecked';
import { VCR1_BASE_URL } from './regos-auth';

const LICENSES_GET_URL = `${VCR1_BASE_URL}/Licenses/Get`;
const LICENSES_REFERER = `${VCR1_BASE_URL}/Licenses/Index`;
const DEFAULT_PAGE_SIZE = 100;
const LIVE_PAGE_SIZE = 50;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

const COLUMNS = [
  'partner',
  'contract',
  'create',
  'status',
  'fm',
  'serial',
  'license',
  'fda_version',
  'app_build_time',
  'db_version',
  'last_receipt_date',
  'last_check_attempt',
  'last_sync',
  'id',
];
const ORDERABLE = [true, true, true, true, true, false, false, true, true, true, true, true, true, false];

function vcr1AjaxHeaders(referer?: any) {
  return {
    Referer: referer,
    'X-Requested-With': 'XMLHttpRequest',
  };
}

function buildFormData({ draw, start, length, search = '' }: Unchecked) {
  const form: Unchecked = {
    draw: String(draw),
    start: String(start),
    length: String(length),
    'search[value]': String(search || ''),
    'search[regex]': 'false',
    'order[0][column]': '0',
    'order[0][dir]': 'DESC',
  };

  COLUMNS.forEach((data?: any, index?: any) => {
    form[`columns[${index}][data]`] = data;
    form[`columns[${index}][name]`] = '';
    form[`columns[${index}][searchable]`] = 'true';
    form[`columns[${index}][orderable]`] = String(ORDERABLE[index]);
    form[`columns[${index}][search][value]`] = '';
    form[`columns[${index}][search][regex]`] = 'false';
  });

  return form;
}

function assertLicensesResponse(payload?: any) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('vcr1 Licenses/Get returned a non-object response');
  }
  if (!Array.isArray(payload.data)) {
    throw new Error('vcr1 Licenses/Get response missing data[]');
  }
  return payload;
}

async function fetchVcr1LicensesPage(
  request: any,
  { start = 0, length = DEFAULT_PAGE_SIZE, draw = 1, search = '' }: Unchecked = {}
) {
  const response = await request.post(LICENSES_GET_URL, {
    form: buildFormData({ draw, start, length, search }),
    headers: vcr1AjaxHeaders(LICENSES_REFERER),
    timeout: DEFAULT_REQUEST_TIMEOUT_MS,
  });

  if (!response.ok()) {
    throw new Error(`vcr1 Licenses/Get failed with status ${response.status()}`);
  }

  const text = await response.text();
  if (text.trimStart().startsWith('<!')) {
    throw new Error('vcr1 Licenses/Get returned login/HTML (session expired)');
  }
  return assertLicensesResponse(JSON.parse(text));
}

async function searchVcr1Licenses(request: any, search: any, { pageSize = LIVE_PAGE_SIZE }: Unchecked = {}) {
  const payload = await fetchVcr1LicensesPage(request, {
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

async function fetchAllVcr1Licenses(
  request: any,
  { pageSize = DEFAULT_PAGE_SIZE, onPage, search = '' }: Unchecked = {}
) {
  const first = await fetchVcr1LicensesPage(request, { start: 0, length: pageSize, draw: 1, search });
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
    const next = await fetchVcr1LicensesPage(request, { start, length: pageSize, draw, search });
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

export {
  DEFAULT_PAGE_SIZE,
  LIVE_PAGE_SIZE,
  fetchAllVcr1Licenses,
  fetchVcr1LicensesPage,
  searchVcr1Licenses,
};
