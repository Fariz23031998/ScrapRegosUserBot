const STORAGE_KEY = 'service_prices_lang';
const UI: any = {
  ru: {
    loading: 'Загрузка…',
    error: 'Не удалось загрузить прайс.',
    updated: 'Обновлено',
  },
  uz: {
    loading: 'Yuklanmoqda…',
    error: 'Narxlarni yuklab bo‘lmadi.',
    updated: 'Yangilangan',
  },
};

const state: any = {
  lang: 'ru',
  catalog: null,
};

function escapeHtml(value: any) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pickLang(preferred: any) {
  return preferred === 'uz' ? 'uz' : 'ru';
}

function readStoredLang() {
  try {
    return pickLang(localStorage.getItem(STORAGE_KEY));
  } catch {
    return 'ru';
  }
}

function storeLang(lang: any) {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // ignore
  }
}

function formatPrice(value: any) {
  if (value == null || value === '') return '—';
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    return Number(text).toLocaleString('ru-RU');
  }
  return text;
}

function formatUpdatedAt(value: any, lang: any) {
  if (!value) return '';
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return `${UI[lang].updated}: ${value}`;
  return `${UI[lang].updated}: ${date.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU')}`;
}

function localized(obj: any, field: any) {
  return obj?.[`${field}_${state.lang}`] || obj?.[`${field}_ru`] || '';
}

function setStatus(text: any, isError: any = false) {
  const el = (document.getElementById('prices-status') as any);
  el.hidden = !text;
  el.className = `prices-status${isError ? ' error' : ''}${text && !isError ? ' prices-status--loading' : ''}`;
  if (!text) {
    el.textContent = '';
    return;
  }
  if (isError) {
    el.textContent = text;
    return;
  }
  el.innerHTML = `
    <span class="prices-status__spinner" aria-hidden="true"></span>
    <span>${escapeHtml(text)}</span>
  `;
}

function syncLangButtons() {
  for (const button of document.querySelectorAll('.lang-btn')) {
    button.setAttribute('aria-pressed', (button as any).dataset.lang === state.lang ? 'true' : 'false');
  }
  document.documentElement.lang = state.lang === 'uz' ? 'uz' : 'ru';
}

function renderCatalog() {
  const catalog = state.catalog;
  const titleEl = (document.getElementById('prices-title') as any);
  const noticeEl = (document.getElementById('prices-notice') as any);
  const updatedEl = (document.getElementById('prices-updated') as any);
  const wrap = (document.getElementById('prices-catalog') as any);

  if (!catalog) return;

  titleEl.textContent = localized(catalog, 'title');
  noticeEl.textContent = localized(catalog, 'notice');
  const updated = formatUpdatedAt(catalog.updated_at, state.lang);
  updatedEl.hidden = !updated;
  updatedEl.textContent = updated;

  const columns = catalog.columns || [];
  wrap.innerHTML = (catalog.categories || [])
    .map((category: any) => {
      const headers = columns
        .map(
          (column: any) =>
            `<th class="cell-num">${escapeHtml(localized(column, 'label'))}</th>`
        )
        .join('');
      const rows = (category.items || [])
        .map((item: any) => {
          const cells = columns
            .map((column: any) => {
              const raw = item.prices?.[column.key];
              const empty = raw == null || raw === '';
              return `<td class="cell-num${empty ? ' price-empty-row' : ''}" data-label="${escapeHtml(
                localized(column, 'label')
              )}">${empty ? '<span class="price-empty">—</span>' : escapeHtml(formatPrice(raw))}</td>`;
            })
            .join('');
          return `<tr><td class="cell-service">${escapeHtml(localized(item, 'name'))}</td>${cells}</tr>`;
        })
        .join('');

      return `
        <section class="price-category">
          <h2 class="price-category__title">${escapeHtml(localized(category, 'name'))}</h2>
          <div class="table-scroll">
            <table class="price-table">
              <thead>
                <tr>
                  <th></th>
                  ${headers}
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </section>
      `;
    })
    .join('');

  wrap.hidden = false;
  setStatus('');
}

async function loadCatalog() {
  setStatus(UI[state.lang].loading);
  const response = await fetch('/api/prices', { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(UI[state.lang].error);
  }
  state.catalog = await response.json();
  renderCatalog();
}

function bindLangSwitch() {
  for (const button of document.querySelectorAll('.lang-btn')) {
    button.addEventListener('click', () => {
      const next = pickLang((button as any).dataset.lang);
      if (next === state.lang) return;
      state.lang = next;
      storeLang(next);
      syncLangButtons();
      if (state.catalog) renderCatalog();
      else setStatus(UI[state.lang].loading);
    });
  }
}

async function init() {
  state.lang = readStoredLang();
  syncLangButtons();
  bindLangSwitch();
  try {
    await loadCatalog();
  } catch (error: any) {
    setStatus(error.message || UI[state.lang].error, true);
  }
}

init();
