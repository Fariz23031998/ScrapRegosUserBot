const PAGE_SIZES = [10, 25, 50, 100];

const NAV_PERMISSION_LINKS = [
  { href: '/bot-admin/', permission: 'users_read' },
  { href: '/bot-admin/orders', permission: 'orders_read' },
  { href: '/bot-admin/order-logs', permission: 'order_logs_read' },
  { href: '/bot-admin/logs', permission: 'logs_read' },
  { href: '/bot-admin/tickets', permission: 'tickets_read' },
  { href: '/bot-admin/technical-support', permission: 'technical_support_read' },
  { href: '/bot-admin/prices', permission: 'prices_read' },
  { href: '/bot-admin/settings', permission: 'settings_read' },
];

const LANDING_REDIRECTS = [
  { permission: 'users_read', href: '/bot-admin/' },
  { permission: 'orders_read', href: '/bot-admin/orders' },
  { permission: 'order_logs_read', href: '/bot-admin/order-logs' },
  { permission: 'logs_read', href: '/bot-admin/logs' },
  { permission: 'tickets_read', href: '/bot-admin/tickets' },
  { permission: 'technical_support_read', href: '/bot-admin/technical-support' },
  { permission: 'prices_read', href: '/bot-admin/prices' },
  { permission: 'settings_read', href: '/bot-admin/settings' },
];

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
  if (response.status === 403) {
    throw new Error(data.message || 'Нет доступа.');
  }
  if (!response.ok) {
    throw new Error(data.message || 'Ошибка запроса');
  }
  return data;
}

function renderLoadingState(message = 'Загрузка…') {
  return `
    <div class="loading-state" role="status" aria-live="polite" aria-busy="true">
      <span class="process-spinner" aria-hidden="true"></span>
      <p class="loading-state__text">${escapeHtml(message)}</p>
    </div>
  `;
}

function setButtonLoading(button, busy) {
  if (!button) return;
  button.classList.toggle('is-loading', Boolean(busy));
  button.disabled = Boolean(busy);
  if (busy) {
    button.setAttribute('aria-busy', 'true');
  } else {
    button.removeAttribute('aria-busy');
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hasPermission(session, key) {
  return Boolean(session?.permissions?.[key]);
}

function firstAllowedAdminHref(session) {
  const permissions = session?.permissions || {};
  for (const item of LANDING_REDIRECTS) {
    if (permissions[item.permission]) return item.href;
  }
  return null;
}

function applyNavPermissions(session) {
  const permissions = session?.permissions || {};
  const nav = document.querySelector('.admin-nav');
  if (!nav) return;

  for (const item of NAV_PERMISSION_LINKS) {
    nav.querySelectorAll(`a[href="${item.href}"]`).forEach((link) => {
      const allowed = Boolean(permissions[item.permission]);
      link.hidden = !allowed;
      if (allowed) {
        link.removeAttribute('aria-hidden');
        link.removeAttribute('tabindex');
      } else {
        link.setAttribute('aria-hidden', 'true');
        link.tabIndex = -1;
      }
    });
  }

  nav.classList.add('admin-nav--ready');
}

function showNoSectionAccess() {
  document.body.innerHTML = `
    <main class="page">
      <p class="message error">Нет доступа к разделам админ-панели. Обратитесь к администратору.</p>
      <p><a href="/bot-admin/login">Выйти / войти снова</a></p>
    </main>
  `;
}

async function ensureSession({ requiredPermission = null, redirectIfMissingUsersHome = false } = {}) {
  const response = await fetch('/bot-admin/api/session', { credentials: 'same-origin' });
  if (!response.ok) {
    window.location.replace('/bot-admin/login');
    throw new Error('Требуется вход в систему.');
  }
  const session = await response.json().catch(() => ({ ok: true, permissions: {} }));
  applyNavPermissions(session);
  mountAccountMenu(session);

  if (requiredPermission && !hasPermission(session, requiredPermission)) {
    const fallback = firstAllowedAdminHref(session);
    if (fallback) {
      window.location.replace(fallback);
    } else {
      showNoSectionAccess();
    }
    throw new Error('Нет доступа.');
  }

  if (redirectIfMissingUsersHome && !hasPermission(session, 'users_read')) {
    const fallback = firstAllowedAdminHref(session);
    if (fallback && fallback !== '/bot-admin/') {
      window.location.replace(fallback);
      throw new Error('Redirecting');
    }
    if (!fallback) {
      showNoSectionAccess();
      throw new Error('Нет доступа к разделам.');
    }
  }

  return session;
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

function initialsFromProfile(profile) {
  const source = String(profile?.displayName || profile?.login || '').trim();
  if (!source) return '?';
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

function ensureCredentialsModal() {
  if (document.getElementById('account-credentials-modal')) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'account-credentials-modal';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="account-credentials-title">
      <div class="modal-header">
        <h3 id="account-credentials-title">Логин и пароль</h3>
        <button type="button" class="modal-close" id="account-credentials-close" aria-label="Закрыть">&times;</button>
      </div>
      <form id="account-credentials-form" class="modal-body" autocomplete="off">
        <label class="field">
          <span>Логин</span>
          <input type="text" name="login" id="account-login" autocomplete="username" required />
        </label>
        <label class="field">
          <span>Текущий пароль</span>
          <input type="password" name="current_password" id="account-current-password" autocomplete="current-password" required />
        </label>
        <label class="field">
          <span>Новый пароль</span>
          <input type="password" name="new_password" id="account-new-password" autocomplete="new-password" placeholder="Оставьте пустым, чтобы не менять" />
        </label>
        <p id="account-credentials-error" class="message error" hidden></p>
        <p id="account-credentials-success" class="message success" hidden></p>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="account-credentials-cancel">Отмена</button>
          <button type="submit" class="btn btn-primary" id="account-credentials-submit">Сохранить</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
}

let accountMenuSession = null;
let accountMenuBound = false;

function setAccountCredentialsMessage(type, text) {
  const errorEl = document.getElementById('account-credentials-error');
  const successEl = document.getElementById('account-credentials-success');
  if (!errorEl || !successEl) return;
  errorEl.hidden = type !== 'error';
  successEl.hidden = type !== 'success';
  errorEl.textContent = type === 'error' ? text || '' : '';
  successEl.textContent = type === 'success' ? text || '' : '';
}

function openAccountCredentialsModal() {
  ensureCredentialsModal();
  const modal = document.getElementById('account-credentials-modal');
  const form = document.getElementById('account-credentials-form');
  if (!modal || !form) return;

  form.reset();
  form.elements.login.value = accountMenuSession?.profile?.login || '';
  setAccountCredentialsMessage(null);
  modal.hidden = false;
  document.documentElement.classList.add('modal-open');
  document.body.classList.add('modal-open');
  form.elements.current_password.focus();
}

function closeAccountCredentialsModal() {
  const modal = document.getElementById('account-credentials-modal');
  if (!modal) return;
  modal.hidden = true;
  document.documentElement.classList.remove('modal-open');
  document.body.classList.remove('modal-open');
}

function updateAccountMenuProfile(profile) {
  const initialsEl = document.getElementById('account-menu-initials');
  const identityEl = document.getElementById('account-menu-identity');
  const credentialsBtn = document.getElementById('account-credentials-btn');
  const toggle = document.getElementById('account-menu-toggle');

  if (initialsEl) {
    initialsEl.textContent = initialsFromProfile(profile);
  }
  if (identityEl) {
    const name = profile?.displayName || profile?.login || 'Аккаунт';
    const login = profile?.login ? `@${profile.login}` : 'Без логина/пароля';
    identityEl.innerHTML = `
      <span class="account-menu__name">${escapeHtml(name)}</span>
      <span class="account-menu__login">${escapeHtml(login)}</span>
    `;
  }
  if (credentialsBtn) {
    credentialsBtn.hidden = !profile?.canChangeCredentials;
  }
  if (toggle) {
    const label = profile?.displayName || profile?.login || 'Аккаунт';
    toggle.setAttribute('aria-label', `Аккаунт: ${label}`);
    toggle.title = label;
  }
}

async function logoutAdmin() {
  await fetch('/bot-admin/api/logout', { method: 'POST', credentials: 'same-origin' });
  window.location.href = '/bot-admin/login';
}

function closeAccountMenuDropdown() {
  const dropdown = document.getElementById('account-menu-dropdown');
  const toggle = document.getElementById('account-menu-toggle');
  if (dropdown) dropdown.hidden = true;
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

function mountAccountMenu(session) {
  const root = document.getElementById('account-menu');
  if (!root) return;

  accountMenuSession = session || accountMenuSession;
  updateAccountMenuProfile(accountMenuSession?.profile || {});

  if (accountMenuBound) return;
  accountMenuBound = true;
  ensureCredentialsModal();

  const toggle = document.getElementById('account-menu-toggle');
  const dropdown = document.getElementById('account-menu-dropdown');
  const credentialsBtn = document.getElementById('account-credentials-btn');
  const logoutBtn = document.getElementById('logout-btn');

  toggle?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!dropdown) return;
    const open = dropdown.hidden;
    dropdown.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  credentialsBtn?.addEventListener('click', () => {
    closeAccountMenuDropdown();
    openAccountCredentialsModal();
  });

  logoutBtn?.addEventListener('click', () => {
    logoutAdmin().catch(() => {
      window.location.href = '/bot-admin/login';
    });
  });

  document.addEventListener('click', (event) => {
    if (!root.contains(event.target)) {
      closeAccountMenuDropdown();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeAccountMenuDropdown();
    const modal = document.getElementById('account-credentials-modal');
    if (modal && !modal.hidden) {
      closeAccountCredentialsModal();
    }
  });

  const modal = document.getElementById('account-credentials-modal');
  modal?.addEventListener('click', (event) => {
    if (event.target === modal) closeAccountCredentialsModal();
  });
  document.getElementById('account-credentials-close')?.addEventListener('click', closeAccountCredentialsModal);
  document.getElementById('account-credentials-cancel')?.addEventListener('click', closeAccountCredentialsModal);

  document.getElementById('account-credentials-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submitBtn = document.getElementById('account-credentials-submit');
    const login = String(form.elements.login.value || '').trim();
    const currentPassword = String(form.elements.current_password.value || '');
    const newPassword = String(form.elements.new_password.value || '');

    setAccountCredentialsMessage(null);
    if (!login) {
      setAccountCredentialsMessage('error', 'Укажите логин.');
      return;
    }
    if (!currentPassword) {
      setAccountCredentialsMessage('error', 'Укажите текущий пароль.');
      return;
    }

    const payload = {
      current_password: currentPassword,
      login,
    };
    if (newPassword) {
      payload.new_password = newPassword;
    }

    setButtonLoading(submitBtn, true);
    try {
      const data = await api('/bot-admin/api/account', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      if (data.profile && accountMenuSession) {
        accountMenuSession.profile = { ...accountMenuSession.profile, ...data.profile };
        updateAccountMenuProfile(accountMenuSession.profile);
      }
      setAccountCredentialsMessage('success', 'Данные для входа обновлены.');
      form.elements.current_password.value = '';
      form.elements.new_password.value = '';
      setTimeout(() => closeAccountCredentialsModal(), 700);
    } catch (error) {
      setAccountCredentialsMessage('error', error.message || 'Не удалось сохранить.');
    } finally {
      setButtonLoading(submitBtn, false);
    }
  });
}

function setupLogout() {
  // Avatar account menu (incl. logout) is mounted from ensureSession via mountAccountMenu.
}
