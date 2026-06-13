const PARTNERS_GET_URL = 'https://sb.regos.uz/Partners/Get';
const DEFAULT_PAGE_SIZE = 100;

function buildFormData({ draw, start, length }) {
  const form = {
    draw: String(draw),
    start: String(start),
    length: String(length),
    'search[value]': '',
    'search[regex]': 'false',
    'order[0][column]': '0',
    'order[0][dir]': 'desc',
  };

  const columns = ['id', 'name', 'legal_status', 'phone', 'contacts', 'description', 'status', 'balance', 'create_date', 'id'];
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

async function fetchPartnersPage(request, { start = 0, length = DEFAULT_PAGE_SIZE, draw = 1 } = {}) {
  const response = await request.post(PARTNERS_GET_URL, {
    form: buildFormData({ draw, start, length }),
  });

  if (!response.ok()) {
    throw new Error(`Partners/Get failed with status ${response.status()}`);
  }

  return response.json();
}

async function fetchAllPartners(request, { pageSize = DEFAULT_PAGE_SIZE, onPage } = {}) {
  const first = await fetchPartnersPage(request, { start: 0, length: pageSize, draw: 1 });
  const total = first.recordsTotal ?? first.data?.length ?? 0;
  const allRows = [...(first.data ?? [])];

  if (onPage) {
    onPage({ page: 1, fetched: allRows.length, total });
  }

  let start = pageSize;
  let draw = 2;
  let pagesFetched = 1;

  while (start < total) {
    pagesFetched += 1;
    const next = await fetchPartnersPage(request, { start, length: pageSize, draw });
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
  fetchAllPartners,
  fetchPartnersPage,
};
