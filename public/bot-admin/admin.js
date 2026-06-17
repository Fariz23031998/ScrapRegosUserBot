const rightsMeta = [];
let users = [];
let modalMode = 'create';

const modalEl = document.getElementById('user-modal');
const userForm = document.getElementById('user-form');
const modalRights = document.getElementById('modal-rights');
const modalError = document.getElementById('modal-error');
const modalTitle = document.getElementById('modal-title');
const modalSubmit = document.getElementById('modal-submit');
const userIdInput = document.getElementById('user-id');

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

function renderUsersTable() {
  const wrap = document.getElementById('users-table-wrap');
  if (!users.length) {
    wrap.innerHTML = '<p class="empty-state">Сотрудников пока нет. Нажмите «Создать сотрудника».</p>';
    return;
  }

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
}

function openModal(mode, user = null) {
  modalMode = mode;
  modalError.hidden = true;
  userForm.reset();
  userIdInput.value = user?.id ?? '';

  if (mode === 'create') {
    modalTitle.textContent = 'Новый сотрудник';
    modalSubmit.textContent = 'Создать';
    renderRightsInputs(modalRights, { see_own_report: true });
  } else {
    modalTitle.textContent = 'Редактирование сотрудника';
    modalSubmit.textContent = 'Сохранить';
    userForm.elements.phone.value = user.phone || '';
    userForm.elements.display_name.value = user.display_name || '';
    renderRightsInputs(modalRights, user.rights || {});
  }

  modalEl.hidden = false;
  userForm.elements.phone.focus();
}

function closeModal() {
  modalEl.hidden = true;
  modalError.hidden = true;
}

async function loadUsers() {
  const data = await api('/bot-admin/api/users');
  users = data.users || [];
  renderUsersTable();
}

async function init() {
  const meta = await api('/bot-admin/rights-meta');
  rightsMeta.push(...(meta.rights || []));
  await loadUsers();
  window.dispatchEvent(new Event('bot-admin-ready'));
}

document.getElementById('create-user-btn').addEventListener('click', () => openModal('create'));

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
