declare var ticketWorkspace: any, ticketViewTabs: any, ticketDetailCard: any, ticketChatCard: any, STATUS_LABELS: any, DIRECTION_LABELS: any, FIRM_TYPE_LABELS: any, userNames: any, ticketSuccessEl: any, ticketErrorEl: any, createOrderErrorEl: any, canEditTickets: any, editTicketToggle: any, ticket: any, canEditClosedTickets: any, ticketTitleEl: any, ticketSubtitleEl: any, ticketDefaultPhone: any, ticketDetailBody: any;
function setTicketView(view: any) {
  const nextView = view === 'detail' ? 'detail' : 'chat';
  ticketWorkspace.dataset.activeView = nextView;
  ticketViewTabs.querySelectorAll('.role-tab').forEach((tab: any) => {
    const isActive = tab.dataset.view === nextView;
    tab.classList.toggle('role-tab--active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
}

function showTicketWorkspace() {
  ticketWorkspace.hidden = false;
  ticketViewTabs.hidden = false;
  ticketDetailCard.hidden = false;
  ticketChatCard.hidden = false;
}

function statusLabel(status: any) {
  return STATUS_LABELS[status] || status || '—';
}

function directionLabel(direction: any) {
  return DIRECTION_LABELS[direction] || direction || '—';
}

function firmTypeLabel(type: any) {
  return FIRM_TYPE_LABELS[type] || type || '—';
}

function formatUnix(seconds: any) {
  if (seconds == null || seconds === 0) return '—';
  const date = new Date(Number(seconds) * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function userLabel(userId: any) {
  if (userId == null) return '—';
  return userNames[userId] || `Пользователь #${userId}`;
}

function statusBadgeClass(status: any) {
  switch (status) {
    case 'Open':
      return 'ticket-status ticket-status--open';
    case 'Closed':
      return 'ticket-status ticket-status--closed';
    case 'WaitingClient':
      return 'ticket-status ticket-status--waiting-client';
    case 'WaitingStaff':
      return 'ticket-status ticket-status--waiting-staff';
    default:
      return 'ticket-status';
  }
}

function showError(message: any) {
  ticketSuccessEl.hidden = true;
  if (!message) {
    ticketErrorEl.hidden = true;
    ticketErrorEl.textContent = '';
    return;
  }
  ticketErrorEl.hidden = false;
  ticketErrorEl.textContent = message;
}

function showSuccess(message: any) {
  ticketErrorEl.hidden = true;
  if (!message) {
    ticketSuccessEl.hidden = true;
    ticketSuccessEl.textContent = '';
    return;
  }
  ticketSuccessEl.hidden = false;
  ticketSuccessEl.textContent = message;
}

function showModalError(message: any) {
  if (!message) {
    createOrderErrorEl.hidden = true;
    createOrderErrorEl.textContent = '';
    return;
  }
  createOrderErrorEl.hidden = false;
  createOrderErrorEl.textContent = message;
}

function detailRow(label: any, value: any) {
  return `
    <div class="ticket-detail__row">
      <dt>${escapeHtml(label)}</dt>
      <dd>${value}</dd>
    </div>
  `;
}

function detailText(value: any) {
  if (value == null || value === '') return '—';
  return escapeHtml(String(value));
}

function isHttpUrl(value: any) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function isAudioUrl(value: any) {
  const text = String(value || '').trim();
  if (!isHttpUrl(text)) return false;
  if (/\.(wav|mp3|ogg|oga|m4a|aac|webm)(?:\?|#|$)/i.test(text)) return true;
  if (/\/recordings\//i.test(text)) return true;
  return false;
}

function isRecordingField(field: any) {
  const key = String(field?.key || '').toLowerCase();
  const name = String(field?.name || '').toLowerCase();
  return (
    key.includes('recording') ||
    name.includes('запись') ||
    name.includes('recording')
  );
}

function formatAudioPlayer(url: any, ticketId: any) {
  const safeUrl = escapeHtml(url);
  const mediaUrl = `/bot-admin/api/tickets/${encodeURIComponent(ticketId)}/recording`;
  return `
    <div class="ticket-audio">
      <audio class="ticket-audio__player" controls preload="metadata" src="${mediaUrl}">
        Ваш браузер не поддерживает воспроизведение аудио.
      </audio>
      <a class="ticket-audio__link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>
    </div>
  `;
}

function formatFieldValue(value: any, field: any = null, ticketId: any = null) {
  if (value == null || value === '') return '—';
  const text = String(value).trim();
  if (ticketId != null && (isAudioUrl(text) || (isHttpUrl(text) && isRecordingField(field)))) {
    return formatAudioPlayer(text, ticketId);
  }
  if (isHttpUrl(text)) {
    return `<a href="${escapeHtml(text)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
  }
  return escapeHtml(text);
}

function renderAdditionalFields(fields: any, ticketId: any) {
  if (!Array.isArray(fields) || fields.length === 0) {
    return detailRow('Нет данных', '—');
  }
  return fields
    .map((field: any) =>
      detailRow(field.name || field.key || 'Поле', formatFieldValue(field.value, field, ticketId))
    )
    .join('');
}

function parseTicketIdFromPath() {
  const match = window.location.pathname.match(/\/bot-admin\/tickets\/(\d+)\/?$/);
  return match ? Number(match[1]) : null;
}

function updateEditTicketToggleVisibility() {
  if (!canEditTickets) {
    editTicketToggle.hidden = true;
    return;
  }
  const isClosed = ticket && String(ticket.status || '') === 'Closed';
  editTicketToggle.hidden = Boolean(isClosed && !canEditClosedTickets);
}

function renderTicket(detail: any) {
  ticket = detail;
  ticketTitleEl.textContent = `Тикет #${detail.id}`;
  ticketSubtitleEl.textContent = detail.subject || '';
  ticketDefaultPhone = detail.client?.phone || '';
  updateEditTicketToggleVisibility();

  const participantIds = Array.isArray(detail.participant_user_ids)
    ? detail.participant_user_ids
    : [];
  const participants =
    participantIds.length > 0
      ? participantIds.map((id: any) => escapeHtml(userLabel(id))).join(', ')
      : '—';

  const descriptionHtml = detail.description
    ? `<div class="ticket-detail__description">${escapeHtml(detail.description)}</div>`
    : '—';

  ticketDetailBody.innerHTML = `
    <section class="ticket-detail__section">
      <h4>Основное</h4>
      <dl class="ticket-detail">
        ${detailRow('Тема', detailText(detail.subject))}
        ${detailRow('Статус', `<span class="${statusBadgeClass(detail.status)}">${escapeHtml(statusLabel(detail.status))}</span>`)}
        ${detailRow('Направление', detailText(directionLabel(detail.direction)))}
        ${detailRow('Создан', detailText(formatUnix(detail.created_date)))}
        ${detailRow('Обновлён', detailText(formatUnix(detail.last_update)))}
        ${detailRow('Описание', descriptionHtml)}
      </dl>
    </section>

    <section class="ticket-detail__section">
      <h4>Клиент</h4>
      <dl class="ticket-detail">
        ${detailRow('Имя', detailText(detail.client?.name))}
        ${detailRow('Телефон', detailText(detail.client?.phone))}
        ${detailRow('Email', detailText(detail.client?.email))}
        ${detailRow('ID клиента', detailText(detail.client_id))}
      </dl>
    </section>

    <section class="ticket-detail__section">
      <h4>Ответственные</h4>
      <dl class="ticket-detail">
        ${detailRow('Ответственный', detailText(userLabel(detail.responsible_user_id)))}
        ${detailRow('Участники', participants)}
      </dl>
    </section>

    <section class="ticket-detail__section">
      <h4>SLA</h4>
      <dl class="ticket-detail">
        ${detailRow('Нарушен', detail.sla_breached ? 'Да' : 'Нет')}
        ${detailRow('Дата нарушения', detailText(formatUnix(detail.sla_breached_date)))}
        ${detailRow('Первый ответ', detailText(formatUnix(detail.first_response_date)))}
        ${detailRow('Срок первого ответа', detailText(formatUnix(detail.first_response_due_date)))}
        ${detailRow('Срок решения', detailText(formatUnix(detail.resolve_due_date)))}
        ${detailRow('Решён', detailText(formatUnix(detail.resolved_date)))}
        ${detailRow('Пропущен', detail.missed ? 'Да' : 'Нет')}
      </dl>
    </section>

    <section class="ticket-detail__section">
      <h4>Оценка</h4>
      <dl class="ticket-detail">
        ${detailRow('Оценка', detailText(detail.rating))}
        ${detailRow('Комментарий', detailText(detail.rating_comment))}
      </dl>
    </section>

    <section class="ticket-detail__section">
      <h4>Настроение клиента</h4>
      <dl class="ticket-detail">
        ${detailRow('Оценка', detailText(detail.client_sentiment_score))}
        ${detailRow('Комментарий', detailText(detail.client_sentiment_comment))}
        ${detailRow('Кто оценил', detailText(userLabel(detail.client_sentiment_user_id)))}
        ${detailRow('Дата', detailText(formatUnix(detail.client_sentiment_date)))}
      </dl>
    </section>

    <section class="ticket-detail__section">
      <h4>Проверка супервайзера</h4>
      <dl class="ticket-detail">
        ${detailRow('Оценка', detailText(detail.supervisor_review_score))}
        ${detailRow('Комментарий', detailText(detail.supervisor_review_comment))}
        ${detailRow('Кто проверил', detailText(userLabel(detail.supervisor_review_user_id)))}
        ${detailRow('Дата', detailText(formatUnix(detail.supervisor_review_date)))}
      </dl>
    </section>

    <section class="ticket-detail__section">
      <h4>Ссылки</h4>
      <dl class="ticket-detail">
        ${detailRow('chat_id', detailText(detail.chat_id))}
        ${detailRow('external_dialog_id', detailText(detail.external_dialog_id))}
        ${detailRow('audio_recording_file_id', detailText(detail.audio_recording_file_id))}
      </dl>
    </section>

    <section class="ticket-detail__section">
      <h4>Дополнительные поля</h4>
      <dl class="ticket-detail">
        ${renderAdditionalFields(detail.fields, detail.id)}
      </dl>
    </section>
  `;

  showTicketWorkspace();
}
