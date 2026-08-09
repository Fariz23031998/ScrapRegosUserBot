const rightsMeta = [];
let users = [];
let regosUsers = [];
let regosUsersLoaded = false;
let modalMode = 'create';
let activeRole = 'employee';
let searchQuery = '';
let currentPage = 1;
let pageLimit = 25;
let totalUsers = 0;
let sessionPermissions = {};

const modalEl = document.getElementById('user-modal');
const userForm = document.getElementById('user-form');
const modalRights = document.getElementById('modal-rights');
const modalError = document.getElementById('modal-error');
const modalTitle = document.getElementById('modal-title');
const modalSubmit = document.getElementById('modal-submit');
const userIdInput = document.getElementById('user-id');
const phoneInput = userForm.elements.phone;
const regosSelect = document.getElementById('regos-user-select');
const regosMatchBtn = document.getElementById('regos-match-btn');
const regosAutoLinkBtn = document.getElementById('regos-auto-link-btn');
const searchInput = document.getElementById('user-search');
const searchClearBtn = document.getElementById('search-clear');
const searchBox = document.getElementById('search-box');
const usersPaginationEl = document.getElementById('users-pagination');

function canCreateUsers() {
  return Boolean(sessionPermissions.users_create);
}
function canEditUsers() {
  return Boolean(sessionPermissions.users_edit);
}
function canDeleteUsers() {
  return Boolean(sessionPermissions.users_delete);
}

function phonesEqual(left, right) {
  const a = String(left || '').replace(/\D/g, '');
  const b = String(right || '').replace(/\D/g, '');
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.endsWith(b) || b.endsWith(a)) return true;
  const aTail = a.slice(-9);
  const bTail = b.slice(-9);
  return aTail.length >= 9 && aTail === bTail;
}

function collectRegosPhones(user) {
  const values = [user.main_phone, user.phones];
  const phones = [];
  for (const value of values) {
    if (!value) continue;
    for (const part of String(value).split(/[,;|/]+/)) {
      const trimmed = part.trim();
      if (trimmed) phones.push(trimmed);
    }
  }
  return phones;
}

function formatRegosOptionLabel(user) {
  const name = user.full_name || [user.last_name, user.first_name].filter(Boolean).join(' ');
  const parts = [name, user.login ? `@${user.login}` : '', user.main_phone || '']
    .map((part) => String(part || '').trim())
    .filter(Boolean);
  return parts.join(' · ') || `ID ${user.id}`;
}

function findRegosMatchesByPhone(phone) {
  return regosUsers.filter((user) =>
    collectRegosPhones(user).some((candidate) => phonesEqual(candidate, phone))
  );
}

async function ensureRegosUsersLoaded({ force = false } = {}) {
  if (regosUsersLoaded && !force) return regosUsers;
  const data = await api('/bot-admin/api/regos-users');
  regosUsers = data.users || [];
  regosUsersLoaded = true;
  return regosUsers;
}

function fillRegosSelect(selectedId = '') {
  const options = ['<option value="">— Не связан —</option>'];
  for (const user of regosUsers) {
    const selected = String(user.id) === String(selectedId) ? ' selected' : '';
    options.push(
      `<option value="${escapeHtml(String(user.id))}"${selected}>${escapeHtml(
        formatRegosOptionLabel(user)
      )}</option>`
    );
  }
  if (selectedId && !regosUsers.some((user) => String(user.id) === String(selectedId))) {
    options.push(
      `<option value="${escapeHtml(String(selectedId))}" selected>ID ${escapeHtml(
        String(selectedId)
      )} (сохранённая привязка)</option>`
    );
  }
  regosSelect.innerHTML = options.join('');
}

function formatRegosLinkHtml(user) {
  if (!user.regos_user_id) {
    return '<span class="rights-summary rights-summary--empty">Не связан</span>';
  }
  const label = user.regos_full_name || user.regos_login || `ID ${user.regos_user_id}`;
  return `<span class="status status-linked">${escapeHtml(label)}</span>`;
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
    <div class="table-scroll">
    <table class="data-table">
      <thead>
        <tr>
          <th>Телефон</th>
          <th>Имя</th>
          <th>Логин</th>
          <th>REGOS</th>
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
            <td class="cell-phone" data-label="Телефон">${escapeHtml(user.phone || '—')}</td>
            <td class="cell-name" data-label="Имя">${formatUserNameHtml(user)}</td>
            <td class="cell-nowrap" data-label="Логин">${
              user.admin_login
                ? escapeHtml(user.admin_login)
                : '<span class="rights-summary rights-summary--empty">—</span>'
            }</td>
            <td data-label="REGOS">${formatRegosLinkHtml(user)}</td>
            <td data-label="Telegram">
              <span class="status ${user.is_linked ? 'status-linked' : 'status-pending'}">
                ${user.is_linked ? `Привязан · ${user.telegram_id}` : 'Ожидает привязки'}
              </span>
            </td>
            <td data-label="Права"><div class="rights-summary">${renderRightsSummary(user.rights)}</div></td>
            <td>
              <div class="row-actions">
                ${
                  canEditUsers()
                    ? '<button type="button" class="btn btn-secondary btn-sm" data-action="edit">Изменить</button>'
                    : ''
                }
                ${
                  canDeleteUsers()
                    ? '<button type="button" class="btn btn-danger btn-sm" data-action="delete">Удалить</button>'
                    : ''
                }
              </div>
            </td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
    </div>
  `;
    return;
  }

  wrap.innerHTML = `
    <div class="table-scroll">
    <table class="data-table">
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
            <td class="cell-phone" data-label="Телефон">${escapeHtml(user.phone || '—')}</td>
            <td class="cell-name" data-label="Имя">${formatUserNameHtml(user)}</td>
            <td data-label="Telegram">
              <span class="status ${user.is_linked ? 'status-linked' : 'status-pending'}">
                ${user.is_linked ? `Привязан · ${user.telegram_id}` : 'Не привязан'}
              </span>
            </td>
            <td class="cell-nowrap" data-label="Привязан">${formatLinkedAt(user.linked_at)}</td>
            <td>
              <div class="row-actions">
                ${
                  canEditUsers()
                    ? '<button type="button" class="btn btn-primary btn-sm" data-action="promote">Сделать сотрудником</button>'
                    : ''
                }
              </div>
            </td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
    </div>
  `;
}

function renderUsersPagination() {
  renderPagination(
    usersPaginationEl,
    { page: currentPage, limit: pageLimit, total: totalUsers },
    {
      onPageChange: (page) => {
        currentPage = page;
        loadUsers().catch((error) => window.alert(error.message));
      },
      onLimitChange: (limit) => {
        pageLimit = limit;
        currentPage = 1;
        loadUsers().catch((error) => window.alert(error.message));
      },
    }
  );
}

async function openModal(mode, user = null) {
  modalMode = mode;
  modalError.hidden = true;
  userForm.reset();
  userIdInput.value = user?.id ?? '';
  phoneInput.readOnly = false;
  phoneInput.required = true;
  const passwordHint = document.getElementById('password-hint');

  try {
    await ensureRegosUsersLoaded();
  } catch (error) {
    regosUsers = [];
    regosUsersLoaded = false;
    console.warn('REGOS users unavailable:', error.message);
  }

  if (mode === 'create') {
    modalTitle.textContent = 'Новый сотрудник';
    modalSubmit.textContent = 'Создать';
    passwordHint.textContent = 'Нужен, если задаёте логин для входа в админ-панель';
    fillRegosSelect('');
    renderRightsInputs(modalRights, { see_own_report: true });
  } else if (mode === 'promote') {
    modalTitle.textContent = 'Назначить сотрудником';
    modalSubmit.textContent = 'Назначить';
    phoneInput.value = user.phone || '';
    phoneInput.readOnly = true;
    phoneInput.required = false;
    const defaultName = user.display_name || formatTelegramName(user);
    userForm.elements.display_name.value = defaultName;
    passwordHint.textContent = 'Нужен, если задаёте логин для входа в админ-панель';
    const matches = findRegosMatchesByPhone(user.phone);
    fillRegosSelect(matches.length === 1 ? matches[0].id : '');
    renderRightsInputs(modalRights, { see_own_report: true });
  } else {
    modalTitle.textContent = 'Редактирование сотрудника';
    modalSubmit.textContent = 'Сохранить';
    userForm.elements.phone.value = user.phone || '';
    userForm.elements.display_name.value = user.display_name || '';
    userForm.elements.admin_login.value = user.admin_login || '';
    passwordHint.textContent = user.has_password
      ? 'Оставьте пустым, чтобы не менять пароль'
      : 'Нужен, если задаёте логин для входа в админ-панель';
    fillRegosSelect(user.regos_user_id || '');
    renderRightsInputs(modalRights, user.rights || {});
  }

  modalEl.hidden = false;
  document.documentElement.classList.add('modal-open');
  document.body.classList.add('modal-open');
  if (mode === 'promote') {
    userForm.elements.display_name.focus();
  } else {
    phoneInput.focus();
  }
}

function closeModal() {
  modalEl.hidden = true;
  modalError.hidden = true;
  document.documentElement.classList.remove('modal-open');
  document.body.classList.remove('modal-open');
}

async function loadUsers() {
  const wrap = document.getElementById('users-table-wrap');
  wrap.innerHTML = renderLoadingState();
  const params = new URLSearchParams({
    role: activeRole,
    page: String(currentPage),
    limit: String(pageLimit),
  });
  if (searchQuery) {
    params.set('q', searchQuery);
  }
  const data = await api(`/bot-admin/api/users?${params.toString()}`);
  users = data.users || [];
  totalUsers = data.total ?? users.length;
  currentPage = data.page ?? currentPage;
  pageLimit = data.limit ?? pageLimit;
  updateSearchBoxUi(searchInput, searchClearBtn, searchBox, searchQuery);
  renderUsersTable();
  renderUsersPagination();
}

function setActiveRole(role) {
  activeRole = role;
  currentPage = 1;
  document.querySelectorAll('.role-tab').forEach((tab) => {
    const isActive = tab.dataset.role === role;
    tab.classList.toggle('role-tab--active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  document.getElementById('create-user-btn').hidden = role !== 'employee' || !canCreateUsers();
  regosAutoLinkBtn.hidden = role !== 'employee' || !canEditUsers();
  loadUsers().catch((error) => window.alert(error.message));
}

async function init() {
  const session = await ensureSession({
    requiredPermission: 'users_read',
    redirectIfMissingUsersHome: true,
  });
  sessionPermissions = session.permissions || {};
  document.getElementById('create-user-btn').hidden = activeRole !== 'employee' || !canCreateUsers();
  regosAutoLinkBtn.hidden = activeRole !== 'employee' || !canEditUsers();
  const meta = await api('/bot-admin/rights-meta');
  rightsMeta.push(...(meta.rights || []));
  await loadUsers();
}

document.getElementById('create-user-btn').addEventListener('click', () => {
  openModal('create').catch((error) => window.alert(error.message));
});

regosMatchBtn.addEventListener('click', async () => {
  try {
    await ensureRegosUsersLoaded();
    const phone = phoneInput.value;
    const matches = findRegosMatchesByPhone(phone);
    if (!matches.length) {
      window.alert('По этому телефону пользователь REGOS не найден.');
      return;
    }
    if (matches.length > 1) {
      window.alert(
        `Найдено несколько пользователей REGOS (${matches.length}). Выберите нужного вручную.`
      );
      fillRegosSelect(regosSelect.value || '');
      return;
    }
    fillRegosSelect(matches[0].id);
  } catch (error) {
    window.alert(error.message);
  }
});

  regosAutoLinkBtn.addEventListener('click', async () => {
  if (!window.confirm('Сопоставить сотрудников с пользователями REGOS по номеру телефона?')) {
    return;
  }
  setButtonLoading(regosAutoLinkBtn, true);
  try {
    const result = await api('/bot-admin/api/users/regos-auto-link', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const summary = result.summary || {};
    window.alert(
      `Готово.\nСопоставлено: ${summary.matched || 0}\nУже связаны: ${
        summary.already_linked || 0
      }\nНе найдено: ${summary.none || 0}\nНеоднозначно: ${summary.ambiguous || 0}`
    );
    await loadUsers();
  } catch (error) {
    window.alert(error.message);
  } finally {
    setButtonLoading(regosAutoLinkBtn, false);
  }
});

document.querySelectorAll('.role-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    if (tab.dataset.role === activeRole) return;
    setActiveRole(tab.dataset.role);
  });
});

bindSearchBox({
  input: searchInput,
  clearBtn: searchClearBtn,
  box: searchBox,
  onSearch: (query) => {
    searchQuery = query;
    currentPage = 1;
    loadUsers().catch((error) => window.alert(error.message));
  },
});

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);

userForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  modalError.hidden = true;
  setButtonLoading(modalSubmit, true);

  const formData = new FormData(userForm);
  const regosUserId = String(formData.get('regos_user_id') || '').trim();
  const payload = {
    phone: formData.get('phone'),
    display_name: formData.get('display_name'),
    admin_login: String(formData.get('admin_login') || '').trim(),
    regos_user_id: regosUserId ? Number(regosUserId) : '',
    rights: collectRights(modalRights),
  };
  if (!regosUserId && (modalMode === 'create' || modalMode === 'promote')) {
    payload.auto_link_regos = true;
    delete payload.regos_user_id;
  }
  const password = String(formData.get('password') || '');
  if (modalMode === 'create' || modalMode === 'promote' || password) {
    payload.password = password;
  }

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
    setButtonLoading(modalSubmit, false);
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
    openModal('edit', user).catch((error) => window.alert(error.message));
    return;
  }

  if (action === 'promote') {
    openModal('promote', user).catch((error) => window.alert(error.message));
    return;
  }

  if (action === 'delete') {
    if (!window.confirm('Удалить сотрудника?')) return;
    setButtonLoading(button, true);
    try {
      await api(`/bot-admin/api/users/${userId}`, { method: 'DELETE' });
      await loadUsers();
    } catch (error) {
      window.alert(error.message);
      setButtonLoading(button, false);
    }
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !modalEl.hidden) closeModal();
});

setupLogout();
init().catch((error) => {
  document.body.innerHTML = `<main class="page"><p class="message error">${escapeHtml(error.message)}</p></main>`;
});
