"use strict";
var rightsMeta = [];
var users = [];
var regosUsers = [];
var regosUsersLoaded = false;
var modalMode = 'create';
var activeRole = 'employee';
var searchQuery = '';
var currentPage = 1;
var pageLimit = 25;
var totalUsers = 0;
var sessionPermissions = {};
var modalEl = document.getElementById('user-modal');
var userForm = document.getElementById('user-form');
var modalRights = document.getElementById('modal-rights');
var modalError = document.getElementById('modal-error');
var modalTitle = document.getElementById('modal-title');
var modalSubmit = document.getElementById('modal-submit');
var userIdInput = document.getElementById('user-id');
var phoneInput = userForm.elements.phone;
var regosSelect = document.getElementById('regos-user-select');
var regosMatchBtn = document.getElementById('regos-match-btn');
var regosAutoLinkBtn = document.getElementById('regos-auto-link-btn');
var searchInput = document.getElementById('user-search');
var searchClearBtn = document.getElementById('search-clear');
var searchBox = document.getElementById('search-box');
var usersPaginationEl = document.getElementById('users-pagination');
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
            .map((user) => `
          <tr data-user-id="${user.id}">
            <td class="cell-phone" data-label="Телефон">${escapeHtml(user.phone || '—')}</td>
            <td class="cell-name" data-label="Имя">${formatUserNameHtml(user)}</td>
            <td class="cell-nowrap" data-label="Логин">${user.admin_login
            ? escapeHtml(user.admin_login)
            : '<span class="rights-summary rights-summary--empty">—</span>'}</td>
            <td data-label="REGOS">${formatRegosLinkHtml(user)}</td>
            <td data-label="Telegram">
              <span class="status ${user.is_linked ? 'status-linked' : 'status-pending'}">
                ${user.is_linked ? `Привязан · ${user.telegram_id}` : 'Ожидает привязки'}
              </span>
            </td>
            <td data-label="Права"><div class="rights-summary">${renderRightsSummary(user.rights)}</div></td>
            <td>
              <div class="row-actions">
                ${canEditUsers()
            ? '<button type="button" class="btn btn-secondary btn-sm" data-action="edit">Изменить</button>'
            : ''}
                ${canDeleteUsers()
            ? '<button type="button" class="btn btn-danger btn-sm" data-action="delete">Удалить</button>'
            : ''}
              </div>
            </td>
          </tr>`)
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
        .map((user) => `
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
                ${canEditUsers()
        ? '<button type="button" class="btn btn-primary btn-sm" data-action="promote">Сделать сотрудником</button>'
        : ''}
              </div>
            </td>
          </tr>`)
        .join('')}
      </tbody>
    </table>
    </div>
  `;
}
function renderUsersPagination() {
    renderPagination(usersPaginationEl, { page: currentPage, limit: pageLimit, total: totalUsers }, {
        onPageChange: (page) => {
            currentPage = page;
            loadUsers().catch((error) => window.alert(error.message));
        },
        onLimitChange: (limit) => {
            pageLimit = limit;
            currentPage = 1;
            loadUsers().catch((error) => window.alert(error.message));
        },
    });
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
    }
    catch (error) {
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
    }
    else if (mode === 'promote') {
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
    }
    else {
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
    }
    else {
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
            window.alert(`Найдено несколько пользователей REGOS (${matches.length}). Выберите нужного вручную.`);
            fillRegosSelect(regosSelect.value || '');
            return;
        }
        fillRegosSelect(matches[0].id);
    }
    catch (error) {
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
        window.alert(`Готово.\nСопоставлено: ${summary.matched || 0}\nУже связаны: ${summary.already_linked || 0}\nНе найдено: ${summary.none || 0}\nНеоднозначно: ${summary.ambiguous || 0}`);
        await loadUsers();
    }
    catch (error) {
        window.alert(error.message);
    }
    finally {
        setButtonLoading(regosAutoLinkBtn, false);
    }
});
document.querySelectorAll('.role-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
        if (tab.dataset.role === activeRole)
            return;
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
        }
        else if (modalMode === 'promote') {
            const userId = userIdInput.value;
            await api(`/bot-admin/api/users/${userId}/promote`, { method: 'POST', body: JSON.stringify(payload) });
            closeModal();
            setActiveRole('employee');
            return;
        }
        else {
            const userId = userIdInput.value;
            await api(`/bot-admin/api/users/${userId}`, { method: 'PUT', body: JSON.stringify(payload) });
        }
        closeModal();
        await loadUsers();
    }
    catch (error) {
        modalError.textContent = error.message;
        modalError.hidden = false;
    }
    finally {
        setButtonLoading(modalSubmit, false);
    }
});
document.getElementById('users-table-wrap').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button)
        return;
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
        if (!window.confirm('Удалить сотрудника?'))
            return;
        setButtonLoading(button, true);
        try {
            await api(`/bot-admin/api/users/${userId}`, { method: 'DELETE' });
            await loadUsers();
        }
        catch (error) {
            window.alert(error.message);
            setButtonLoading(button, false);
        }
    }
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modalEl.hidden)
        closeModal();
});
setupLogout();
init().catch((error) => {
    document.body.innerHTML = `<main class="page"><p class="message error">${escapeHtml(error.message)}</p></main>`;
});
