const STATUS_LABELS = {
  Open: 'Открыт',
  Closed: 'Закрыт',
  WaitingClient: 'Ожидание клиента',
  WaitingStaff: 'Ожидание сотрудника',
};

const DIRECTION_LABELS = {
  Inbound: 'Входящий',
  Outbound: 'Исходящий',
};

const UNASSIGNED_LABEL = 'Не назначен';

const HIDDEN_SYSTEM_ACTIONS = new Set(['TicketEdited', 'TicketParticipantsSet']);

function parseActionPayload(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function statusLabel(status) {
  const key = String(status || '').trim();
  return STATUS_LABELS[key] || key || '—';
}

function directionLabel(direction) {
  const key = String(direction || '').trim();
  return DIRECTION_LABELS[key] || key || '—';
}

function resolveUserLabel(userId, userNames) {
  const id = Number(userId);
  if (!Number.isFinite(id) || id <= 0) return UNASSIGNED_LABEL;
  return userNames[id] || `Пользователь #${id}`;
}

function ticketIdFromPayload(payload, fallbackTicketId) {
  const id = Number(payload?.id);
  if (Number.isFinite(id) && id > 0) return id;
  const fallback = Number(fallbackTicketId);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
}

function formatTicketCreated(payload, fallbackTicketId) {
  const ticketId = ticketIdFromPayload(payload, fallbackTicketId);
  const subject = String(payload?.subject || '').trim() || (ticketId ? `#${ticketId}` : 'обращение');
  const direction = directionLabel(payload?.direction);
  const status = statusLabel(payload?.status);
  return `Создано обращение ${subject} (${direction}, ${status})`;
}

function formatTicketClosed(payload, fallbackTicketId) {
  const ticketId = ticketIdFromPayload(payload, fallbackTicketId);
  const status = statusLabel(payload?.status);
  if (ticketId) {
    return `Обращение #${ticketId} закрыто (${status})`;
  }
  return `Обращение закрыто (${status})`;
}

function formatTicketResponsibleSet(payload, fallbackTicketId, userNames) {
  const ticketId = ticketIdFromPayload(payload, fallbackTicketId);
  const oldLabel = resolveUserLabel(payload?.old_responsible_user_id, userNames);
  const newLabel = resolveUserLabel(payload?.responsible_user_id, userNames);
  if (ticketId) {
    return `Изменен ответственный обращения #${ticketId} ${oldLabel} -> ${newLabel}`;
  }
  return `Изменен ответственный обращения ${oldLabel} -> ${newLabel}`;
}

function formatTicketStatusSet(payload, fallbackTicketId) {
  const ticketId = ticketIdFromPayload(payload, fallbackTicketId);
  const oldStatus = statusLabel(payload?.old_status);
  const newStatus = statusLabel(payload?.status);
  if (ticketId) {
    return `Изменен статус обращения #${ticketId} ${oldStatus} -> ${newStatus}`;
  }
  return `Изменен статус обращения ${oldStatus} -> ${newStatus}`;
}

function formatStaffNoticeAdded(payload, message) {
  const text = String(payload?.text || message?.text || '').trim();
  return text || null;
}

function isHiddenSystemMessage(message) {
  if (String(message?.message_type || '') !== 'System') {
    return false;
  }
  const actionCode = String(message?.action_code || '').trim();
  if (HIDDEN_SYSTEM_ACTIONS.has(actionCode)) {
    return true;
  }
  const text = String(message?.text || '').trim();
  return HIDDEN_SYSTEM_ACTIONS.has(text);
}

function formatSystemChatMessage(message, { userNames = {}, ticketId } = {}) {
  if (String(message?.message_type || '') !== 'System') {
    return null;
  }
  if (isHiddenSystemMessage(message)) {
    return null;
  }

  const existingText = String(message?.text || '').trim();
  if (existingText) {
    return existingText;
  }

  const actionCode = String(message?.action_code || '').trim();
  const payload = parseActionPayload(message?.action_payload);
  if (!actionCode) {
    return 'Системное событие';
  }

  switch (actionCode) {
    case 'TicketCreated':
    case 'TicketAdded':
      return payload ? formatTicketCreated(payload, ticketId) : 'Создано обращение';
    case 'TicketClosed':
      return payload ? formatTicketClosed(payload, ticketId) : 'Обращение закрыто';
    case 'TicketResponsibleSet':
      return payload
        ? formatTicketResponsibleSet(payload, ticketId, userNames)
        : 'Изменен ответственный обращения';
    case 'TicketStatusSet':
      return payload ? formatTicketStatusSet(payload, ticketId) : 'Изменен статус обращения';
    case 'StaffNoticeAdded':
      return formatStaffNoticeAdded(payload, message) || 'Системное уведомление';
    default:
      return actionCode;
  }
}

function enrichChatMessages(messages, options = {}) {
  return (messages || [])
    .filter((message) => !isHiddenSystemMessage(message))
    .map((message) => {
      const displayText = formatSystemChatMessage(message, options);
      if (!displayText) {
        return message;
      }
      return { ...message, display_text: displayText };
    });
}

module.exports = {
  STATUS_LABELS,
  DIRECTION_LABELS,
  UNASSIGNED_LABEL,
  HIDDEN_SYSTEM_ACTIONS,
  parseActionPayload,
  isHiddenSystemMessage,
  formatSystemChatMessage,
  enrichChatMessages,
};
