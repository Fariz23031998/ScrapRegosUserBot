let channels = [];
let canEditSettings = false;

const settingsWrap = document.getElementById('channel-settings-wrap');
const saveButton = document.getElementById('save-channel-settings');
const messageEl = document.getElementById('channel-settings-message');

function showSettingsMessage(text, type = null) {
  messageEl.textContent = text || '';
  messageEl.className = `message${type ? ` ${type}` : ''}`;
  messageEl.hidden = !text;
}

function renderChannelSettings() {
  if (!channels.length) {
    settingsWrap.innerHTML = '<p class="empty-state">Каналы REGOS не найдены.</p>';
    return;
  }

  settingsWrap.innerHTML = `
    <div class="table-scroll">
      <table class="data-table settings-channels-table">
        <thead>
          <tr>
            <th>Канал</th>
            <th>Статус</th>
            <th>Тип взаимодействия</th>
          </tr>
        </thead>
        <tbody>
          ${channels
            .map(
              (channel) => `
                <tr>
                  <td data-label="Канал">
                    <span class="name-primary">${escapeHtml(channel.name)}</span>
                    <span class="name-secondary">ID: ${escapeHtml(channel.id)}</span>
                  </td>
                  <td data-label="Статус">
                    <span class="badge ${channel.available ? 'badge--ok' : 'badge--muted'}">
                      ${channel.available ? (channel.active ? 'Активен' : 'Неактивен') : 'Удалён из REGOS'}
                    </span>
                  </td>
                  <td data-label="Тип взаимодействия">
                    <select class="channel-mode-select" data-channel-id="${escapeHtml(channel.id)}" ${
                      canEditSettings ? '' : 'disabled'
                    }>
                      <option value="message_only" ${
                        channel.interaction_mode === 'message_only' ? 'selected' : ''
                      }>Только сообщения</option>
                      <option value="call" ${
                        channel.interaction_mode === 'call' ? 'selected' : ''
                      }>Звонки</option>
                    </select>
                  </td>
                </tr>
              `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function loadChannelSettings() {
  showSettingsMessage('');
  settingsWrap.innerHTML = renderLoadingState('Загрузка каналов…');
  const data = await api('/bot-admin/api/settings/channels');
  channels = data.channels || [];
  renderChannelSettings();
}

async function saveChannelSettings() {
  showSettingsMessage('');
  setButtonLoading(saveButton, true);
  try {
    const modes = new Map(
      [...settingsWrap.querySelectorAll('.channel-mode-select')].map((select) => [
        select.dataset.channelId,
        select.value,
      ])
    );
    const data = await api('/bot-admin/api/settings/channels', {
      method: 'PUT',
      body: JSON.stringify({
        channels: channels.map((channel) => ({
          id: channel.id,
          interaction_mode: modes.get(channel.id),
        })),
      }),
    });
    channels = data.channels || channels;
    renderChannelSettings();
    showSettingsMessage('Настройки каналов сохранены.', 'success');
  } catch (error) {
    showSettingsMessage(error.message || 'Не удалось сохранить настройки.', 'error');
  } finally {
    setButtonLoading(saveButton, false);
    saveButton.disabled = !canEditSettings;
  }
}

async function init() {
  const session = await ensureSession({ requiredPermission: 'settings_read' });
  canEditSettings = hasPermission(session, 'settings_edit');
  saveButton.hidden = !canEditSettings;
  saveButton.disabled = !canEditSettings;
  await loadChannelSettings();
  setupLogout();
}

saveButton.addEventListener('click', saveChannelSettings);

init().catch((error) => {
  showSettingsMessage(error.message || 'Не удалось загрузить настройки.', 'error');
  settingsWrap.innerHTML = '';
});
