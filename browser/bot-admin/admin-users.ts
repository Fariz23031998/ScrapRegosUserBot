declare var sessionPermissions: any, regosUsers: any, regosUsersLoaded: any, regosSelect: any, rightsMeta: any;
function canCreateUsers() {
  return Boolean(sessionPermissions.users_create);
}
function canEditUsers() {
  return Boolean(sessionPermissions.users_edit);
}
function canDeleteUsers() {
  return Boolean(sessionPermissions.users_delete);
}

function phonesEqual(left: any, right: any) {
  const a = String(left || '').replace(/\D/g, '');
  const b = String(right || '').replace(/\D/g, '');
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.endsWith(b) || b.endsWith(a)) return true;
  const aTail = a.slice(-9);
  const bTail = b.slice(-9);
  return aTail.length >= 9 && aTail === bTail;
}

function collectRegosPhones(user: any) {
  const values = [user.main_phone, user.phones];
  const phones: any[] = [];
  for (const value of values) {
    if (!value) continue;
    for (const part of String(value).split(/[,;|/]+/)) {
      const trimmed = part.trim();
      if (trimmed) phones.push(trimmed);
    }
  }
  return phones;
}

function formatRegosOptionLabel(user: any) {
  const name = user.full_name || [user.last_name, user.first_name].filter(Boolean).join(' ');
  const parts = [name, user.login ? `@${user.login}` : '', user.main_phone || '']
    .map((part: any) => String(part || '').trim())
    .filter(Boolean);
  return parts.join(' · ') || `ID ${user.id}`;
}

function findRegosMatchesByPhone(phone: any) {
  return regosUsers.filter((user: any) =>
    collectRegosPhones(user).some((candidate: any) => phonesEqual(candidate, phone))
  );
}

async function ensureRegosUsersLoaded({ force = false }: any = {}) {
  if (regosUsersLoaded && !force) return regosUsers;
  const data = await api('/bot-admin/api/regos-users');
  regosUsers = data.users || [];
  regosUsersLoaded = true;
  return regosUsers;
}

function fillRegosSelect(selectedId: any = '') {
  const options = ['<option value="">— Не связан —</option>'];
  for (const user of regosUsers) {
    const selected = String(user.id) === String(selectedId) ? ' selected' : '';
    options.push(
      `<option value="${escapeHtml(String(user.id))}"${selected}>${escapeHtml(
        formatRegosOptionLabel(user)
      )}</option>`
    );
  }
  if (selectedId && !regosUsers.some((user: any) => String(user.id) === String(selectedId))) {
    options.push(
      `<option value="${escapeHtml(String(selectedId))}" selected>ID ${escapeHtml(
        String(selectedId)
      )} (сохранённая привязка)</option>`
    );
  }
  regosSelect.innerHTML = options.join('');
}

function formatRegosLinkHtml(user: any) {
  if (!user.regos_user_id) {
    return '<span class="rights-summary rights-summary--empty">Не связан</span>';
  }
  const label = user.regos_full_name || user.regos_login || `ID ${user.regos_user_id}`;
  return `<span class="status status-linked">${escapeHtml(label)}</span>`;
}

function renderRightsInputs(container: any, selected: any = {}) {
  container.innerHTML = rightsMeta
    .map(
      (right: any) => `
      <label class="rights-item">
        <input type="checkbox" data-right="${right.key}" ${selected[right.key] ? 'checked' : ''} />
        <span>${escapeHtml(right.label)}</span>
      </label>`
    )
    .join('');
}

function collectRights(container: any) {
  const rights: any = {};
  container.querySelectorAll('input[data-right]').forEach((input: any) => {
    rights[input.dataset.right] = input.checked;
  });
  return rights;
}

function formatTelegramName(user: any) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
}

function formatUserNameHtml(user: any) {
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

function renderRightsSummary(rights: any = {}) {
  const active = rightsMeta.filter((right: any) => rights[right.key]);
  if (!active.length) {
    return '<span class="rights-summary rights-summary--empty">Нет прав</span>';
  }
  if (active.length <= 2) {
    return active.map((right: any) => `<span class="rights-tag">${escapeHtml(right.label)}</span>`).join('');
  }
  return `<span class="rights-tag">${active.length} права</span>`;
}

function formatLinkedAt(value: any) {
  if (!value) return '—';
  const date = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return escapeHtml(date.toLocaleString('ru-RU'));
}
