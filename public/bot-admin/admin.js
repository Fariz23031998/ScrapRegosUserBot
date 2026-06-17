const rightsMeta = [];
let users = [];
let modalMode = 'create';
let activeRole = 'employee';
let searchQuery = '';
let searchTimer = null;

const modalEl = document.getElementById('user-modal');
const userForm = document.getElementById('user-form');
const modalRights = document.getElementById('modal-rights');
const modalError = document.getElementById('modal-error');
const modalTitle = document.getElementById('modal-title');
const modalSubmit = document.getElementById('modal-submit');
const userIdInput = document.getElementById('user-id');
const phoneInput = userForm.elements.phone;
const searchInput = document.getElementById('user-search');
const searchClearBtn = document.getElementById('search-clear');
const searchBox = document.getElementById('search-box');

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

function renderRightsInputs(container, selected = {}) {
  container.innerHTML = rightsMeta
    .map(
      (right) => `
      <label class="rights-item">
        <input type="checkbox" data-right="${right.key}" ${selected[right.key] ? 'checked' : ''} />
        <span>${escapeHtml(right.label)}</span>
      </label>`
    )
    .join('');
}

function collectRights(container) {
  const rights = {};
  container.querySelectorAll('input[data-right]').forEach((input) => {
    rights[input.dataset.right] = input.checked;
  });
  return rights;
}

function formatTelegramName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
}

function formatUserNameHtml(user) {
  const telegramName = formatTelegramName(user);
  const adminName = String(user.display_name || '').trim();

  if (adminName && telegramName) {
    return `<span class="name-primary">${escapeHtml(adminName)}</span><span class="name-secondary">${escapeHtml(telegramName)}</span>`;
  }
  if (adminName) {
    return escapeHtml(adminName);
  }
  if (telegramName) {
    return escapeHtml(telegramName);
  }
  if (user.username) {
    return escapeHtml(`@${user.username}`);
  }
  return '—';
}

function renderRightsSummary(rights = {}) {
  const active = rightsMeta.filter((right) => rights[right.key]);
  if (!active.length) {
    return '<span class="rights-summary rights-summary--empty">Нет прав</span>';
  }
  if (active.length <= 2) {
    return active.map((right) => `<span class="rights-tag">${escapeHtml(right.label)}</span>`).join('');
  }
  return `<span class="rights-tag">${active.length} права</span>`;
}

function formatLinkedAt(value) {
  if (!value) return '—';
  const date = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return escapeHtml(date.toLocaleString('ru-RU'));
}

function renderUsersTable() {
  const wrap = document.getElementById('users-table-wrap');
  const isEmployeeView = activeRole === 'employee';

  if (!users.length) {
    const emptyMessage = searchQuery
      ? 'Ничего не найдено. Попробуйте другой запрос.'
      : isEmployeeView
        ? 'Сотрудников пока нет. Нажмите «Создать сотрудника».'
        : 'Клиентов пока нет. Они появятся после регистрации в боте.';
    wrap.innerHTML = `<p class="empty-state">${emptyMessage}</p>`;
    return;
  }

  if (isEmployeeView) {
    wrap.innerHTML = `
    <table class="users-table">
      <thead>
        <tr>
          <th>Телефон</th>
          <th>Имя</th>
          <th>Telegram</th>
          <th>Права</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${users
          .map(
            (user) => `
          <tr data-user-id="${user.id}">
            <td class="cell-phone">${escapeHtml(user.phone || '—')}</td>
            <td class="cell-name">${formatUserNameHtml(user)}</td>
            <td>
              <span class="status ${user.is_linked ? 'status-linked' : 'status-pending'}">
                ${user.is_linked ? `Привязан · ${user.telegram_id}` : 'Ожидает привязки'}
              </span>
            </td>
            <td><div class="rights-summary">${renderRightsSummary(user.rights)}</div></td>
            <td>
              <div class="row-actions">
                <button type="button" class="btn btn-secondary btn-sm" data-action="edit">Изменить</button>
                <button type="button" class="btn btn-danger btn-sm" data-action="delete">Удалить</button>
              </div>
            </td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
  `;
    return;
  }

  wrap.innerHTML = `
    <table class="users-table">
      <thead>
        <tr>
          <th>Телефон</th>
          <th>Имя</th>
          <th>Telegram</th>
          <th>Привязан</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${users
          .map(
            (user) => `
          <tr data-user-id="${user.id}">
            <td class="cell-phone">${escapeHtml(user.phone || '—')}</td>
            <td class="cell-name">${formatUserNameHtml(user)}</td>
            <td>
              <span class="status ${user.is_linked ? 'status-linked' : 'status-pending'}">
                ${user.is_linked ? `Привязан · ${user.telegram_id}` : 'Не привязан'}
              </span>
            </td>
            <td class="cell-nowrap">${formatLinkedAt(user.linked_at)}</td>
            <td>
              <div class="row-actions">
                <button type="button" class="btn btn-primary btn-sm" data-action="promote">Сделать сотрудником</button>
              </div>
            </td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
  `;
}

function openModal(mode, user = null) {
  modalMode = mode;
  modalError.hidden = true;
  userForm.reset();
  userIdInput.value = user?.id ?? '';
  phoneInput.readOnly = false;
  phoneInput.required = true;

  if (mode === 'create') {
    modalTitle.textContent = 'Новый сотрудник';
    modalSubmit.textContent = 'Создать';
    renderRightsInputs(modalRights, { see_own_report: true });
  } else if (mode === 'promote') {
    modalTitle.textContent = 'Назначить сотрудником';
    modalSubmit.textContent = 'Назначить';
    phoneInput.value = user.phone || '';
    phoneInput.readOnly = true;
    phoneInput.required = false;
    const defaultName = user.display_name || formatTelegramName(user);
    userForm.elements.display_name.value = defaultName;
    renderRightsInputs(modalRights, { see_own_report: true });
  } else {
    modalTitle.textContent = 'Редактирование сотрудника';
    modalSubmit.textContent = 'Сохранить';
    userForm.elements.phone.value = user.phone || '';
    userForm.elements.display_name.value = user.display_name || '';
    renderRightsInputs(modalRights, user.rights || {});
  }

  modalEl.hidden = false;
  if (mode === 'promote') {
    userForm.elements.display_name.focus();
  } else {
    phoneInput.focus();
  }
}

function closeModal() {
  modalEl.hidden = true;
  modalError.hidden = true;
}

function updateSearchUi() {
  const hasQuery = searchQuery.length > 0;
  searchClearBtn.hidden = !hasQuery;
  searchBox.classList.toggle('search-box--active', hasQuery);
}

async function loadUsers() {
  const params = new URLSearchParams({ role: activeRole });
  if (searchQuery) {
    params.set('q', searchQuery);
  }
  const data = await api(`/bot-admin/api/users?${params.toString()}`);
  users = data.users || [];
  updateSearchUi();
  renderUsersTable();
}

function setActiveRole(role) {
  activeRole = role;
  document.querySelectorAll('.role-tab').forEach((tab) => {
    const isActive = tab.dataset.role === role;
    tab.classList.toggle('role-tab--active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  document.getElementById('create-user-btn').hidden = role !== 'employee';
  loadUsers().catch((error) => window.alert(error.message));
}

async function init() {
  const meta = await api('/bot-admin/rights-meta');
  rightsMeta.push(...(meta.rights || []));
  await loadUsers();
  window.dispatchEvent(new Event('bot-admin-ready'));
}

document.getElementById('create-user-btn').addEventListener('click', () => openModal('create'));

document.querySelectorAll('.role-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    if (tab.dataset.role === activeRole) return;
    setActiveRole(tab.dataset.role);
  });
});

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchQuery = searchInput.value.trim();
    updateSearchUi();
    loadUsers().catch((error) => window.alert(error.message));
  }, 300);
});

searchClearBtn.addEventListener('click', () => {
  searchInput.value = '';
  searchQuery = '';
  updateSearchUi();
  loadUsers().catch((error) => window.alert(error.message));
  searchInput.focus();
});

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);
modalEl.addEventListener('click', (event) => {
  if (event.target === modalEl) closeModal();
});

userForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  modalError.hidden = true;
  modalSubmit.disabled = true;

  const formData = new FormData(userForm);
  const payload = {
    phone: formData.get('phone'),
    display_name: formData.get('display_name'),
    rights: collectRights(modalRights),
  };

  try {
    if (modalMode === 'create') {
      await api('/bot-admin/api/users', { method: 'POST', body: JSON.stringify(payload) });
    } else if (modalMode === 'promote') {
      const userId = userIdInput.value;
      await api(`/bot-admin/api/users/${userId}/promote`, { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      setActiveRole('employee');
      return;
    } else {
      const userId = userIdInput.value;
      await api(`/bot-admin/api/users/${userId}`, { method: 'PUT', body: JSON.stringify(payload) });
    }
    closeModal();
    await loadUsers();
  } catch (error) {
    modalError.textContent = error.message;
    modalError.hidden = false;
  } finally {
    modalSubmit.disabled = false;
  }
});

document.getElementById('users-table-wrap').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;

  const row = button.closest('tr[data-user-id]');
  const userId = Number(row.dataset.userId);
  const user = users.find((item) => item.id === userId);
  const action = button.dataset.action;

  if (action === 'edit') {
    openModal('edit', user);
    return;
  }

  if (action === 'promote') {
    openModal('promote', user);
    return;
  }

  if (action === 'delete') {
    if (!window.confirm('Удалить сотрудника?')) return;
    try {
      await api(`/bot-admin/api/users/${userId}`, { method: 'DELETE' });
      await loadUsers();
    } catch (error) {
      window.alert(error.message);
    }
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/bot-admin/api/logout', { method: 'POST', credentials: 'same-origin' });
  window.location.href = '/bot-admin/login';
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !modalEl.hidden) closeModal();
});

init().catch((error) => {
  document.body.innerHTML = `<main class="page"><p class="message error">${escapeHtml(error.message)}</p></main>`;
});
