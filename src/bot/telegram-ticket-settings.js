const { getSettings, setSettings } = require('../db/app-settings');
const { normalizeParticipantUserIds } = require('../integrations/regos-crm');

const SETTING_KEYS = {
  enabled: 'telegram_ticket_enabled',
  channelId: 'telegram_ticket_channel_id',
  direction: 'telegram_ticket_direction',
  responsibleUserId: 'telegram_ticket_responsible_user_id',
  participantUserIds: 'telegram_ticket_participant_user_ids',
  subject: 'telegram_ticket_subject',
  fallbackClientId: 'telegram_ticket_fallback_client_id',
};

const ALLOWED_DIRECTIONS = ['Inbound', 'Outbound'];
const DEFAULT_DIRECTION = 'Inbound';
const DEFAULT_SUBJECT = 'Вопрос из Telegram';
const MAX_SUBJECT_LENGTH = 300;

function parseBooleanSetting(value, fallback = false) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseOptionalPositiveId(value) {
  if (value == null || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function normalizeOptionalPositiveId(value, errorCode) {
  if (value == null || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(errorCode);
  }
  return id;
}

function normalizeDirection(value) {
  if (value == null || value === '') return DEFAULT_DIRECTION;
  const direction = String(value).trim();
  if (!ALLOWED_DIRECTIONS.includes(direction)) {
    throw new Error('INVALID_TELEGRAM_TICKET_DIRECTION');
  }
  return direction;
}

function normalizeSubject(value) {
  const subject = String(value == null || value === '' ? DEFAULT_SUBJECT : value).trim();
  if (!subject || subject.length > MAX_SUBJECT_LENGTH) {
    throw new Error('INVALID_TELEGRAM_TICKET_SUBJECT');
  }
  return subject;
}

function normalizeParticipantIds(value) {
  if (value == null || value === '') return [];
  let rows = value;
  if (typeof value === 'string') {
    try {
      rows = JSON.parse(value);
    } catch {
      throw new Error('INVALID_TELEGRAM_TICKET_PARTICIPANTS');
    }
  }
  if (!Array.isArray(rows)) {
    throw new Error('INVALID_TELEGRAM_TICKET_PARTICIPANTS');
  }
  return normalizeParticipantUserIds(rows);
}

function parseStoredParticipantIds(value) {
  try {
    return normalizeParticipantIds(value);
  } catch {
    return [];
  }
}

function parseStoredDirection(value) {
  try {
    return normalizeDirection(value);
  } catch {
    return DEFAULT_DIRECTION;
  }
}

function parseStoredSubject(value) {
  try {
    return normalizeSubject(value);
  } catch {
    return DEFAULT_SUBJECT;
  }
}

function loadTelegramTicketSettings(db) {
  const stored = getSettings(db, Object.values(SETTING_KEYS));
  return {
    enabled: parseBooleanSetting(stored[SETTING_KEYS.enabled], false),
    channelId: parseOptionalPositiveId(stored[SETTING_KEYS.channelId]),
    direction: parseStoredDirection(stored[SETTING_KEYS.direction]),
    responsibleUserId: parseOptionalPositiveId(stored[SETTING_KEYS.responsibleUserId]),
    participantUserIds: parseStoredParticipantIds(stored[SETTING_KEYS.participantUserIds]),
    subject: parseStoredSubject(stored[SETTING_KEYS.subject]),
    fallbackClientId: parseOptionalPositiveId(stored[SETTING_KEYS.fallbackClientId]),
  };
}

function saveTelegramTicketSettings(db, patch = {}) {
  const current = loadTelegramTicketSettings(db);
  const next = {
    enabled: patch.enabled != null ? Boolean(patch.enabled) : current.enabled,
    channelId:
      patch.channelId !== undefined
        ? normalizeOptionalPositiveId(patch.channelId, 'INVALID_TELEGRAM_TICKET_CHANNEL')
        : current.channelId,
    direction:
      patch.direction != null ? normalizeDirection(patch.direction) : current.direction,
    responsibleUserId:
      patch.responsibleUserId !== undefined
        ? normalizeOptionalPositiveId(
            patch.responsibleUserId,
            'INVALID_TELEGRAM_TICKET_RESPONSIBLE'
          )
        : current.responsibleUserId,
    participantUserIds:
      patch.participantUserIds != null
        ? normalizeParticipantIds(patch.participantUserIds)
        : current.participantUserIds,
    subject: patch.subject != null ? normalizeSubject(patch.subject) : current.subject,
    fallbackClientId:
      patch.fallbackClientId !== undefined
        ? normalizeOptionalPositiveId(
            patch.fallbackClientId,
            'INVALID_TELEGRAM_TICKET_FALLBACK_CLIENT'
          )
        : current.fallbackClientId,
  };

  if (next.enabled && !next.channelId) {
    throw new Error('TELEGRAM_TICKET_CHANNEL_REQUIRED');
  }

  setSettings(db, {
    [SETTING_KEYS.enabled]: next.enabled ? '1' : '0',
    [SETTING_KEYS.channelId]: next.channelId == null ? null : String(next.channelId),
    [SETTING_KEYS.direction]: next.direction,
    [SETTING_KEYS.responsibleUserId]:
      next.responsibleUserId == null ? null : String(next.responsibleUserId),
    [SETTING_KEYS.participantUserIds]: JSON.stringify(next.participantUserIds),
    [SETTING_KEYS.subject]: next.subject,
    [SETTING_KEYS.fallbackClientId]:
      next.fallbackClientId == null ? null : String(next.fallbackClientId),
  });

  return next;
}

function serializeTelegramTicketSettings(settings) {
  return {
    enabled: Boolean(settings.enabled),
    channel_id: settings.channelId ?? null,
    direction: settings.direction || DEFAULT_DIRECTION,
    responsible_user_id: settings.responsibleUserId ?? null,
    participant_user_ids: Array.isArray(settings.participantUserIds)
      ? settings.participantUserIds
      : [],
    subject: settings.subject || DEFAULT_SUBJECT,
    fallback_client_id: settings.fallbackClientId ?? null,
  };
}

function isTelegramTicketConfigured(settings) {
  return Boolean(settings?.enabled && settings?.channelId);
}

module.exports = {
  SETTING_KEYS,
  ALLOWED_DIRECTIONS,
  DEFAULT_DIRECTION,
  DEFAULT_SUBJECT,
  MAX_SUBJECT_LENGTH,
  loadTelegramTicketSettings,
  saveTelegramTicketSettings,
  serializeTelegramTicketSettings,
  isTelegramTicketConfigured,
};
