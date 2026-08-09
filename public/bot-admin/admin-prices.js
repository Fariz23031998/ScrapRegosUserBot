const PRICE_KEYS = ['fixed', 'min5', 'min30', 'hour1', 'hour2'];
const PRICE_LABELS = {
  fixed: 'ФИКСА',
  min5: '5 мин',
  min30: '30 мин',
  hour1: '1 час',
  hour2: '2 часа',
};

const state = {
  columns: [],
  categories: [],
  canCreate: false,
  canEdit: false,
  canDelete: false,
};

function canSaveCatalog() {
  return state.canCreate || state.canEdit || state.canDelete;
}

function showMessage(text, isError = false) {
  const el = document.getElementById('catalog-message');
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = text;
  el.className = `message ${isError ? 'error' : 'success'}`;
}

function emptyItem() {
  return {
    name_ru: '',
    name_uz: '',
    prices: { fixed: '', min5: '', min30: '', hour1: '', hour2: '' },
  };
}

function emptyCategory() {
  return {
    name_ru: '',
    name_uz: '',
    items: [emptyItem()],
  };
}

function readForm() {
  return {
    title_ru: document.getElementById('title-ru').value,
    title_uz: document.getElementById('title-uz').value,
    notice_ru: document.getElementById('notice-ru').value,
    notice_uz: document.getElementById('notice-uz').value,
    categories: state.categories,
  };
}

function bindCategoryEvents() {
  const root = document.getElementById('categories-editor');

  root.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.getAttribute('data-action');
      const categoryIndex = Number(button.getAttribute('data-category'));
      const itemIndex = Number(button.getAttribute('data-item'));

      if (action === 'add-item') {
        state.categories[categoryIndex].items.push(emptyItem());
      } else if (action === 'remove-item') {
        state.categories[categoryIndex].items.splice(itemIndex, 1);
        if (!state.categories[categoryIndex].items.length) {
          state.categories[categoryIndex].items.push(emptyItem());
        }
      } else if (action === 'move-item-up' && itemIndex > 0) {
        const items = state.categories[categoryIndex].items;
        [items[itemIndex - 1], items[itemIndex]] = [items[itemIndex], items[itemIndex - 1]];
      } else if (action === 'move-item-down') {
        const items = state.categories[categoryIndex].items;
        if (itemIndex < items.length - 1) {
          [items[itemIndex + 1], items[itemIndex]] = [items[itemIndex], items[itemIndex + 1]];
        }
      } else if (action === 'remove-category') {
        state.categories.splice(categoryIndex, 1);
        if (!state.categories.length) state.categories.push(emptyCategory());
      } else if (action === 'move-category-up' && categoryIndex > 0) {
        const cats = state.categories;
        [cats[categoryIndex - 1], cats[categoryIndex]] = [cats[categoryIndex], cats[categoryIndex - 1]];
      } else if (action === 'move-category-down' && categoryIndex < state.categories.length - 1) {
        const cats = state.categories;
        [cats[categoryIndex + 1], cats[categoryIndex]] = [cats[categoryIndex], cats[categoryIndex + 1]];
      }
      renderCategories();
    });
  });

  root.querySelectorAll('[data-field]').forEach((input) => {
    input.addEventListener('input', () => {
      const categoryIndex = Number(input.getAttribute('data-category'));
      const itemIndex = input.hasAttribute('data-item')
        ? Number(input.getAttribute('data-item'))
        : null;
      const field = input.getAttribute('data-field');
      const priceKey = input.getAttribute('data-price');

      if (itemIndex == null) {
        state.categories[categoryIndex][field] = input.value;
        return;
      }
      if (priceKey) {
        state.categories[categoryIndex].items[itemIndex].prices[priceKey] = input.value;
        return;
      }
      state.categories[categoryIndex].items[itemIndex][field] = input.value;
    });
  });
}

function renderCategories() {
  const root = document.getElementById('categories-editor');
  const readonlyAttr = state.canEdit ? '' : 'readonly';
  root.innerHTML = state.categories
    .map((category, categoryIndex) => {
      const itemsHtml = category.items
        .map((item, itemIndex) => {
          const priceInputs = PRICE_KEYS.map(
            (key) => `
              <label class="field field-compact">
                <span>${PRICE_LABELS[key]}</span>
                <input
                  type="text"
                  data-field="prices"
                  data-price="${key}"
                  data-category="${categoryIndex}"
                  data-item="${itemIndex}"
                  value="${escapeHtml(item.prices?.[key] || '')}"
                  maxlength="80"
                  ${readonlyAttr}
                />
              </label>
            `
          ).join('');

          return `
            <div class="price-item-card">
              <div class="bilingual-grid">
                <label class="field">
                  <span>Услуга (RU)</span>
                  <input type="text" data-field="name_ru" data-category="${categoryIndex}" data-item="${itemIndex}" value="${escapeHtml(
                    item.name_ru || ''
                  )}" maxlength="300" required ${readonlyAttr} />
                </label>
                <label class="field">
                  <span>Xizmat (UZ)</span>
                  <input type="text" data-field="name_uz" data-category="${categoryIndex}" data-item="${itemIndex}" value="${escapeHtml(
                    item.name_uz || ''
                  )}" maxlength="300" required ${readonlyAttr} />
                </label>
              </div>
              <div class="price-fields-grid">${priceInputs}</div>
              <div class="editor-actions">
                ${
                  state.canEdit
                    ? `<button type="button" class="btn btn-secondary btn-sm" data-action="move-item-up" data-category="${categoryIndex}" data-item="${itemIndex}">↑</button>
                <button type="button" class="btn btn-secondary btn-sm" data-action="move-item-down" data-category="${categoryIndex}" data-item="${itemIndex}">↓</button>`
                    : ''
                }
                ${
                  state.canDelete
                    ? `<button type="button" class="btn btn-danger btn-sm" data-action="remove-item" data-category="${categoryIndex}" data-item="${itemIndex}">Удалить услугу</button>`
                    : ''
                }
              </div>
            </div>
          `;
        })
        .join('');

      return `
        <article class="category-editor-card">
          <div class="card-toolbar">
            <h3>Категория ${categoryIndex + 1}</h3>
            <div class="editor-actions">
              ${
                state.canEdit
                  ? `<button type="button" class="btn btn-secondary btn-sm" data-action="move-category-up" data-category="${categoryIndex}">↑</button>
              <button type="button" class="btn btn-secondary btn-sm" data-action="move-category-down" data-category="${categoryIndex}">↓</button>`
                  : ''
              }
              ${
                state.canDelete
                  ? `<button type="button" class="btn btn-danger btn-sm" data-action="remove-category" data-category="${categoryIndex}">Удалить категорию</button>`
                  : ''
              }
            </div>
          </div>
          <div class="bilingual-grid">
            <label class="field">
              <span>Категория (RU)</span>
              <input type="text" data-field="name_ru" data-category="${categoryIndex}" value="${escapeHtml(
                category.name_ru || ''
              )}" maxlength="300" required ${readonlyAttr} />
            </label>
            <label class="field">
              <span>Turkum (UZ)</span>
              <input type="text" data-field="name_uz" data-category="${categoryIndex}" value="${escapeHtml(
                category.name_uz || ''
              )}" maxlength="300" required ${readonlyAttr} />
            </label>
          </div>
          ${itemsHtml}
          ${
            state.canCreate
              ? `<button type="button" class="btn btn-secondary btn-sm" data-action="add-item" data-category="${categoryIndex}">+ Услуга</button>`
              : ''
          }
        </article>
      `;
    })
    .join('');

  bindCategoryEvents();
}

function fillMeta(catalog) {
  const readonly = !state.canEdit;
  const titleRu = document.getElementById('title-ru');
  const titleUz = document.getElementById('title-uz');
  const noticeRu = document.getElementById('notice-ru');
  const noticeUz = document.getElementById('notice-uz');
  titleRu.value = catalog.title_ru || '';
  titleUz.value = catalog.title_uz || '';
  noticeRu.value = catalog.notice_ru || '';
  noticeUz.value = catalog.notice_uz || '';
  titleRu.readOnly = readonly;
  titleUz.readOnly = readonly;
  noticeRu.readOnly = readonly;
  noticeUz.readOnly = readonly;
}

async function loadCatalog() {
  const catalog = await api('/bot-admin/api/prices');
  state.columns = catalog.columns || [];
  state.categories = (catalog.categories || []).map((category) => ({
    name_ru: category.name_ru,
    name_uz: category.name_uz,
    items: (category.items || []).map((item) => ({
      name_ru: item.name_ru,
      name_uz: item.name_uz,
      prices: {
        fixed: item.prices?.fixed || '',
        min5: item.prices?.min5 || '',
        min30: item.prices?.min30 || '',
        hour1: item.prices?.hour1 || '',
        hour2: item.prices?.hour2 || '',
      },
    })),
  }));
  if (!state.categories.length) state.categories.push(emptyCategory());
  fillMeta(catalog);
  renderCategories();
}

async function saveCatalog() {
  showMessage('');
  try {
    const catalog = await api('/bot-admin/api/prices', {
      method: 'PUT',
      body: JSON.stringify(readForm()),
    });
    state.categories = catalog.categories.map((category) => ({
      name_ru: category.name_ru,
      name_uz: category.name_uz,
      items: category.items.map((item) => ({
        name_ru: item.name_ru,
        name_uz: item.name_uz,
        prices: { ...item.prices },
      })),
    }));
    fillMeta(catalog);
    renderCategories();
    showMessage('Прайс сохранён.');
  } catch (error) {
    showMessage(error.message || 'Не удалось сохранить прайс.', true);
  }
}

async function init() {
  const session = await ensureSession({ requiredPermission: 'prices_read' });
  state.canCreate = Boolean(session.permissions?.prices_create);
  state.canEdit = Boolean(session.permissions?.prices_edit);
  state.canDelete = Boolean(session.permissions?.prices_delete);
  setupLogout();
  await loadCatalog();

  const addCategoryBtn = document.getElementById('add-category-btn');
  const saveBtn = document.getElementById('save-catalog-btn');
  addCategoryBtn.hidden = !state.canCreate;
  saveBtn.hidden = !canSaveCatalog();

  if (state.canCreate) {
    addCategoryBtn.addEventListener('click', () => {
      state.categories.push(emptyCategory());
      renderCategories();
    });
  }
  if (canSaveCatalog()) {
    saveBtn.addEventListener('click', saveCatalog);
  }
}

init().catch((error) => {
  console.error(error);
  window.location.href = '/bot-admin/login';
});
