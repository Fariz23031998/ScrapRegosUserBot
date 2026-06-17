const PAGE_SIZES = [10, 25, 50, 100];

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    window.location.href = '/bot-admin/login';
    throw new Error('Требуется вход в систему.');
  }
  if (!response.ok) {
    throw new Error(data.message || 'Ошибка запроса');
  }
  return data;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function ensureSession() {
  const response = await fetch('/bot-admin/api/session', { credentials: 'same-origin' });
  if (!response.ok) {
    window.location.replace('/bot-admin/login');
    throw new Error('Требуется вход в систему.');
  }
}

function updateSearchBoxUi(searchInput, searchClearBtn, searchBox, query) {
  const hasQuery = query.length > 0;
  searchClearBtn.hidden = !hasQuery;
  searchBox.classList.toggle('search-box--active', hasQuery);
}

function bindSearchBox({ input, clearBtn, box, onSearch, debounceMs = 300 }) {
  let timer = null;

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      onSearch(input.value.trim());
    }, debounceMs);
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    onSearch('');
    input.focus();
  });
}

function paginationHtml({ page, limit, total }) {
  const totalPages = Math.max(1, Math.ceil(total / limit) || 1);
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const from = total === 0 ? 0 : (safePage - 1) * limit + 1;
  const to = Math.min(safePage * limit, total);

  return `
    <div class="pagination">
      <div class="pagination__info">${from}–${to} из ${total}</div>
      <div class="pagination__controls">
        <label class="pagination__size">
          <span>На странице</span>
          <select class="pagination__limit" aria-label="Записей на странице">
            ${PAGE_SIZES.map(
              (size) =>
                `<option value="${size}" ${size === limit ? 'selected' : ''}>${size}</option>`
            ).join('')}
          </select>
        </label>
        <button type="button" class="btn btn-secondary btn-sm pagination__prev" ${safePage <= 1 ? 'disabled' : ''}>Назад</button>
        <span class="pagination__page">${safePage} / ${totalPages}</span>
        <button type="button" class="btn btn-secondary btn-sm pagination__next" ${safePage >= totalPages ? 'disabled' : ''}>Вперёд</button>
      </div>
    </div>
  `;
}

function bindPagination(container, { page, limit, total, onPageChange, onLimitChange }) {
  const totalPages = Math.max(1, Math.ceil(total / limit) || 1);
  const safePage = Math.min(Math.max(page, 1), totalPages);

  container.querySelector('.pagination__prev')?.addEventListener('click', () => {
    if (safePage > 1) onPageChange(safePage - 1);
  });
  container.querySelector('.pagination__next')?.addEventListener('click', () => {
    if (safePage < totalPages) onPageChange(safePage + 1);
  });
  container.querySelector('.pagination__limit')?.addEventListener('change', (event) => {
    onLimitChange(Number(event.target.value));
  });
}

function renderPagination(container, state, handlers) {
  container.innerHTML = paginationHtml(state);
  bindPagination(container, { ...state, ...handlers });
}

function setupLogout() {
  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    await fetch('/bot-admin/api/logout', { method: 'POST', credentials: 'same-origin' });
    window.location.href = '/bot-admin/login';
  });
}
