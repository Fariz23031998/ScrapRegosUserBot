const fs = require('fs');
const path = require('path');
const express = require('express');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const {
  createEmployeeUser,
  updateEmployeeUser,
  convertCustomerToEmployee,
  deleteEmployeeUser,
  listBotUsers,
  findEmployeeByAdminLogin,
  verifyAdminPassword,
  getBotUserById,
  getEmployeeWithRights,
  setBotUserRegosLink,
  clearBotUserRegosLink,
  listEmployeeUsers,
} = require('../db/bot-users-db');
const { RIGHTS } = require('../db/user-rights');
const { listOrderLogs, mapOrderLogRow, formatPaymentProviderLabel } = require('../db/order-logs');
const {
  listAdminAuditLogs,
  mapAdminAuditLogRow,
  logAdminAudit,
  buildAuditDetails,
  buildFieldChanges,
} = require('../db/admin-audit-logs');
const {
  getAdminCredentials,
  isAuthenticated,
  getSessionActor,
  getSessionPermissions,
  actorHasPermission,
  setSessionCookie,
  clearSessionCookie,
  requireAdminAuth,
  requireRight,
  requireAnyRight,
} = require('./bot-admin-auth');
const {
  consumeDashboardLoginToken,
  lookupDashboardLoginToken,
  hasActiveDashboardSession,
  invalidateDashboardLoginTokensForTelegramId,
} = require('./dashboard-login-tokens');
const {
  getTelegramBotToken,
  parseTelegramWebAppInitData,
} = require('./telegram-webapp-auth');
const { hasRight, isLinkedEmployee } = require('../db/user-rights');
const { getBotUserByTelegramId } = require('../db/bot-users-db');
const {
  listTechnicalSupportPrices,
  updateTechnicalSupportPrices,
  listTechnicalSupportSubscriptions,
  createManualTechnicalSupportSubscription,
  deactivateTechnicalSupportSubscription,
  updateTechnicalSupportSubscriptionEndsAt,
  deleteTechnicalSupportSubscription,
  getTechnicalSupportSubscriptionById,
  mapSubscriptionRow,
} = require('../db/technical-support');
const {
  enrichTicketsWithLocalData,
  resolveMissingTicketRecordings,
  scheduleTicketRecordingDurationBackfill,
} = require('./ticket-local-enrichment');
const { enrichChatMessages } = require('./chat-system-message');
const {
  getTicketRecording,
  upsertTicketRecording,
} = require('../db/ticket-recordings');
const { setTicketAiStopped, isTicketAiStopped } = require('../db/ticket-ai-state');
const {
  getServicePricesCatalog,
  replaceServicePricesCatalog,
} = require('../db/service-prices');
const {
  listRegosChannelSettings,
  replaceRegosChannelSettings,
  mergeRegosChannelsWithSettings,
} = require('../db/regos-channel-settings');
const {
  RegosCrmError,
  DEFAULT_DUPLICATE_INTERVAL_MINUTES,
  fetchAllTickets,
  fetchAllUsers,
  fetchAllChannels,
  searchClients,
  getClientById,
  editClient,
  createTicket,
  editTicket,
  setTicketStatus,
  setTicketResponsible,
  setTicketParticipants,
  normalizeParticipantUserIds,
  participantUserIdsEqual,
  mapRegosUserSummary,
  mapRegosChannelSummary,
  matchPhoneToRegosUser,
  planRegosLinksByPhone,
  dedupeTickets,
  summarizeTickets,
  buildTicketFilters,
  findLatestTicketForResponsibleUser,
  findTicketById,
  resolveActiveTicket,
  mapActiveTicket,
  getTicketMessages,
  addTicketMessage,
  addChatFile,
  getFilesByIds,
  getChatFilesByIds,
  ensureTicketParticipant,
  isTicketStaffParticipant,
  DEFAULT_CHAT_MESSAGE_LIMIT,
} = require('../integrations/regos-crm');
const { botAdminPublicDir, botAdminUiDistDir } = require('../paths');
const { sendVersionedHtmlFile } = require('../http/asset-cache');
const { createOrder, listOrders, getOrderById, deletePendingOrder, deletePaidCashOrder, markPendingOrderPaidCash } = require('../db/partners-db');
const {
  listLinksByClient,
  addLink: addClientFirmLink,
  removeLink: removeClientFirmLink,
  getLinkById,
} = require('../db/client-firm-links');
const { looksLikePhone, normalizePhone, searchFirmAdmin, getFirmCardByTypeAndId } = require('../bot/search-user');
const {
  parsePositiveAmount,
  formatOrderPaymentMessage,
  afterOrderCreated,
} = require('../bot/service-bot');
const { enrichOrderParties } = require('../bot/order-parties');
const { formatRenotifyResultMessage } = require('../bot/order-actions-bot');
const { getOutboundBot } = require('../bot/payment-notification');
const { withHtml } = require('../bot/telegram-html');
const { formatPaymentPageUrl, getDefaultPaymentProvider } = require('../payments/payments-api');
const { formatClickUrlSafe } = require('../payments/click');
const { enqueueOrderPaymentSms } = require('../sms/sms-queue');
const { ticketEventHub } = require('./ticket-events');
const { loadAiSettings, saveAiSettings, serializeAiSettings } = require('../ai/settings');
const {
  loadTelegramTicketSettings,
  saveTelegramTicketSettings,
  serializeTelegramTicketSettings,
} = require('../bot/telegram-ticket-settings');

function isAiCredentialError(error) {
  const message = String(error?.message || '');
  return (
    message === 'OPENAI_API_KEY is not configured' ||
    message === 'GEMINI_API_KEY is not configured' ||
    /OPENAI_API_KEY|GEMINI_API_KEY/.test(message)
  );
}

function aiCredentialErrorMessage(error) {
  const message = String(error?.message || '');
  if (message.includes('GEMINI')) {
    return 'AI не настроен. Укажите API-ключ Gemini в настройках или GEMINI_API_KEY.';
  }
  return 'AI не настроен. Укажите API-ключ OpenAI в настройках или OPENAI_API_KEY.';
}
const { notifyGroupTopic } = require('../ai/tools/notify-group');
const { listToolSchemas, runAgentToolTest } = require('../ai/tools/test-runner');
const { runKbAgent } = require('../ai/kb-agent');
const { previewCustomerAgentPrompt } = require('../ai/customer-agent');
const { loadCustomerTestSession, runCustomerTestAgent } = require('../ai/customer-test-agent');
const { loadEmployeeTestSession, runEmployeeTestAgent } = require('../ai/employee-test-agent');
const {
  listCustomerTestSessions,
  deleteCustomerTestSession,
  clearCustomerTestSessions,
} = require('../db/customer-agent-sessions');
const { loadTicketAssistSession, runTicketAssistAgent } = require('../ai/customer-assist-agent');
const { CHAT_MESSAGE_JSON_LIMIT, parseChatUploadFiles } = require('../ai/chat-uploads');
const {
  listKnowledgeArticles,
  getKnowledgeArticle,
  createKnowledgeArticle,
  updateKnowledgeArticle,
  deleteKnowledgeArticle,
  setKnowledgeArticleLocked,
  getOrCreateKbSession,
  listKbSessionMessages,
  clearKbSessionHistory,
  listKnowledgeCategories,
  getKnowledgeCategory,
  createKnowledgeCategory,
  updateKnowledgeCategory,
  deleteKnowledgeCategory,
} = require('../db/knowledge-articles');
const {
  listPromptTypes,
  getPrompt,
  createPrompt,
  updatePrompt,
  setActivePrompt,
  deletePrompt,
} = require('../db/ai-prompts');
const {
  listPromptVariables,
  getPromptVariable,
  createPromptVariable,
  updatePromptVariable,
  deletePromptVariable,
  testVariableSource,
} = require('../db/ai-prompt-variables');
const {
  listToolDescriptions,
  getToolDescription,
  saveToolDescription,
  resetToolDescription,
} = require('../db/ai-tool-descriptions');
const {
  getTicketSummary,
  saveTicketSummaryText,
  deleteTicketSummary,
} = require('../db/ticket-summaries');
const { resolveTicketClientId } = require('../ai/ticket-period');
const { createKnowledgeMcpRouter } = require('../mcp/knowledge-mcp');
const { registerTaskRoutes } = require('./tasks-admin');
const { registerReportRoutes } = require('./reports-admin');
const { getTicketRecordingUrl } = require('./ticket-recording');
const { buildDurationSummary } = require('./ticket-duration');
const {
  summarizeByDuration,
  buildDurationsByTicketId,
} = require('../../public/bot-admin/admin-ticket-summary');
const crypto = require('crypto');

const RECORDING_URL_CACHE_TTL_MS = 10 * 60 * 1000;
const RECORDING_URL_CACHE_MAX = 1000;

function seedRecordingUrlCache(cache, ticketId, href) {
  if (!href || ticketId == null) return null;
  let url;
  try {
    url = new URL(String(href));
  } catch {
    return null;
  }
  const key = String(ticketId);
  if (!cache.has(key) && cache.size >= RECORDING_URL_CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, {
    href: url.href,
    expiresAt: Date.now() + RECORDING_URL_CACHE_TTL_MS,
  });
  return url;
}

function parseRightsBody(body = {}) {
  const rights = {};
  for (const key of Object.keys(RIGHTS)) {
    if (body[key] !== undefined) {
      rights[key] = body[key] ? 1 : 0;
    }
  }
  return rights;
}

async function loadMergedChannelSettings(db) {
  const channels = (await fetchAllChannels()).map(mapRegosChannelSummary);
  return mergeRegosChannelsWithSettings(channels, listRegosChannelSettings(db));
}

function resolveSessionRegosUserId(db, req) {
  const actor = getSessionActor(req);
  if (!actor) return null;
  let botUser = null;
  if (actor.type === 'telegram') {
    botUser = getBotUserByTelegramId(db, actor.telegramId);
  } else if (actor.type === 'user') {
    botUser = getBotUserById(db, actor.userId);
  }
  return botUser?.regos_user_id != null ? Number(botUser.regos_user_id) : null;
}

function resolveSessionBotUser(db, req) {
  const actor = getSessionActor(req);
  if (!actor) return null;
  if (actor.type === 'telegram') {
    return getBotUserByTelegramId(db, actor.telegramId);
  }
  if (actor.type === 'user') {
    return getBotUserById(db, actor.userId);
  }
  return null;
}

function displayNameForBotUser(botUser) {
  if (!botUser) return null;
  const composed = [botUser.first_name, botUser.last_name].filter(Boolean).join(' ').trim();
  return (
    (botUser.display_name && String(botUser.display_name).trim()) ||
    composed ||
    botUser.admin_login ||
    botUser.phone ||
    null
  );
}

function buildSessionProfile(db, actor) {
  if (!actor) {
    return {
      login: null,
      displayName: null,
      canChangeCredentials: false,
    };
  }

  if (actor.type === 'password') {
    const creds = getAdminCredentials();
    const login = creds?.login || null;
    return {
      login,
      displayName: login || 'Администратор',
      canChangeCredentials: false,
    };
  }

  const botUser = (() => {
    if (actor.type === 'telegram') return getBotUserByTelegramId(db, actor.telegramId);
    if (actor.type === 'user') return getBotUserById(db, actor.userId);
    return null;
  })();

  const login = botUser?.admin_login || null;
  return {
    login,
    displayName: displayNameForBotUser(botUser),
    canChangeCredentials: Boolean(botUser?.role === 'employee' && login && botUser.password_hash),
  };
}

function mapUserResponse(user) {
  return {
    id: user.id,
    role: user.role,
    phone: user.phone,
    display_name: user.display_name,
    job_title: user.job_title || null,
    description: user.description || null,
    first_name: user.first_name,
    last_name: user.last_name,
    username: user.username,
    telegram_id: user.telegram_id,
    linked_at: user.linked_at,
    is_linked: user.is_linked,
    admin_login: user.admin_login || null,
    has_password: Boolean(user.password_hash),
    regos_user_id: user.regos_user_id ?? null,
    regos_login: user.regos_login || null,
    regos_full_name: user.regos_full_name || null,
    rights: user.rights,
  };
}

function snapshotUserForAudit(user) {
  if (!user) return null;
  return {
    id: user.id,
    role: user.role ?? null,
    phone: user.phone ?? null,
    display_name: user.display_name ?? null,
    job_title: user.job_title ?? null,
    description: user.description ?? null,
    admin_login: user.admin_login || null,
    has_password: Boolean(user.password_hash || user.has_password),
    regos_user_id: user.regos_user_id ?? null,
    regos_login: user.regos_login || null,
    regos_full_name: user.regos_full_name || null,
    rights: user.rights || null,
  };
}

function snapshotOrderForAudit(order) {
  if (!order) return null;
  return {
    id: order.id,
    status: order.status ?? null,
    amount: order.order_amount ?? order.amount ?? null,
    client_phone: order.client_phone ?? null,
    additional_phone: order.additional_phone ?? null,
    payment_provider: order.payment_provider ?? null,
    ticket_id: order.ticket_id ?? null,
  };
}

function snapshotPricesForAudit(prices) {
  if (!Array.isArray(prices)) return null;
  return prices.map((row) => ({
    months: row.months,
    amount: row.amount,
    configured: row.configured,
  }));
}

function snapshotCatalogForAudit(catalog) {
  if (!catalog || typeof catalog !== 'object') return null;
  return {
    title_ru: catalog.title_ru ?? null,
    title_uz: catalog.title_uz ?? null,
    categories_count: Array.isArray(catalog.categories) ? catalog.categories.length : 0,
    items_count: Array.isArray(catalog.categories)
      ? catalog.categories.reduce(
          (sum, category) => sum + (Array.isArray(category.items) ? category.items.length : 0),
          0
        )
      : 0,
    categories: Array.isArray(catalog.categories)
      ? catalog.categories.map((category) => ({
          name_ru: category.name_ru ?? null,
          name_uz: category.name_uz ?? null,
          items_count: Array.isArray(category.items) ? category.items.length : 0,
        }))
      : [],
  };
}

function parseOptionalCredential(value) {
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function summarizeRegosUser(user) {
  return mapRegosUserSummary(user);
}

async function resolveRegosUserById(regosUserId) {
  const id = Number(regosUserId);
  if (!Number.isFinite(id) || id <= 0) {
    throw Object.assign(new Error('INVALID_REGOS_USER'), { code: 'INVALID_REGOS_USER' });
  }
  const users = await fetchAllUsers({ activeOnly: false });
  const found = users.find((user) => Number(user.id) === id);
  if (!found) {
    throw Object.assign(new Error('REGOS_USER_NOT_FOUND'), { code: 'REGOS_USER_NOT_FOUND' });
  }
  return found;
}

async function buildRegosUserNameMap() {
  const users = await fetchAllUsers({ activeOnly: false });
  const userNames = {};
  for (const user of users) {
    const id = Number(user.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    userNames[id] = user.full_name || user.login || `Пользователь #${id}`;
  }
  return userNames;
}

async function applyRegosLinkToUser(db, userId, { regosUserId, autoLink = false } = {}) {
  if (regosUserId === null || regosUserId === '') {
    return clearBotUserRegosLink(db, userId);
  }

  if (regosUserId !== undefined && regosUserId !== null && regosUserId !== '') {
    const regosUser = await resolveRegosUserById(regosUserId);
    return setBotUserRegosLink(db, userId, {
      regosUserId: regosUser.id,
      regosLogin: regosUser.login,
      regosFullName: summarizeRegosUser(regosUser).full_name,
    });
  }

  if (!autoLink) {
    return getEmployeeWithRights(db, userId) || getBotUserById(db, userId);
  }

  const botUser = getBotUserById(db, userId);
  if (!botUser) {
    throw new Error('NOT_FOUND');
  }
  if (botUser.regos_user_id != null) {
    return getEmployeeWithRights(db, userId) || botUser;
  }

  const regosUsers = await fetchAllUsers({ activeOnly: true });
  const used = new Set(
    listEmployeeUsers(db)
      .map((user) => Number(user.regos_user_id))
      .filter((id) => Number.isFinite(id))
  );
  const match = matchPhoneToRegosUser(botUser.phone, regosUsers, { excludeRegosIds: used });
  if (match.status !== 'matched') {
    return getEmployeeWithRights(db, userId) || botUser;
  }
  return setBotUserRegosLink(db, userId, {
    regosUserId: match.user.id,
    regosLogin: match.user.login,
    regosFullName: summarizeRegosUser(match.user).full_name,
  });
}

function mapRegosLinkError(error) {
  const code = error.code || error.message;
  const messages = {
    INVALID_REGOS_USER: 'Некорректный пользователь REGOS.',
    REGOS_USER_NOT_FOUND: 'Пользователь REGOS не найден.',
    REGOS_USER_LINKED: 'Этот пользователь REGOS уже привязан к другому сотруднику бота.',
    NOT_FOUND: 'Пользователь не найден.',
  };
  if (messages[code]) {
    return { status: code === 'NOT_FOUND' ? 404 : 400, message: messages[code] };
  }
  if (error instanceof RegosCrmError) {
    return { status: error.status, message: error.message };
  }
  return null;
}

function sendPublicFile(res, publicDir, filename) {
  const absolutePath = path.join(publicDir, filename);
  if (String(filename).toLowerCase().endsWith('.html')) {
    return sendVersionedHtmlFile(res, absolutePath);
  }
  return res.sendFile(absolutePath);
}

function botAdminReactUiIndexPath() {
  return path.join(botAdminUiDistDir(), 'index.html');
}

/** React SPA is the default UI when `bot-admin-ui/dist` is built. */
function isBotAdminReactUiReady() {
  if (String(process.env.BOT_ADMIN_USE_LEGACY_UI || '').trim() === '1') {
    return false;
  }
  return fs.existsSync(botAdminReactUiIndexPath());
}

function sendBotAdminReactUiIndex(res) {
  return res.sendFile(botAdminReactUiIndexPath());
}

function isBotAdminSpaPath(reqPath) {
  const pathname = String(reqPath || '').split('?')[0];
  if (!pathname || pathname === '/') return false;
  if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/auth/') ||
    pathname.startsWith('/mcp') ||
    pathname === '/rights-meta'
  ) {
    return false;
  }
  if (path.extname(pathname)) return false;
  return true;
}

function parsePaginationQuery(req) {
  const allowedLimits = [10, 25, 50, 100];
  let limit = Number(req.query.limit) || 25;
  if (!allowedLimits.includes(limit)) {
    limit = 25;
  }
  const page = Math.max(Number(req.query.page) || 1, 1);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

const ORDER_STATUS_LABELS = {
  pending: 'Неоплачен',
  paid: 'Оплачен',
  paid_cash: 'Оплачен',
  deleted: 'Удалён',
};

function isPaidOrderStatus(status) {
  return status === 'paid' || status === 'paid_cash';
}

function mapAdminOrderRow(order) {
  const paymentProvider = isPaidOrderStatus(order.status) ? order.payment_provider ?? null : null;
  return {
    id: order.id,
    status: order.status,
    status_label: ORDER_STATUS_LABELS[order.status] || order.status,
    amount: order.amount,
    currency: order.currency,
    client_phone: order.client_phone,
    additional_phone: order.additional_phone ?? null,
    bot_user_phone: order.bot_user_phone ?? null,
    employee_name: order.employee_name || null,
    employee_phone: order.employee_phone || order.bot_user_phone || null,
    customer_name: order.customer_name || null,
    payment_provider: paymentProvider,
    payment_provider_label: formatPaymentProviderLabel(paymentProvider),
    ticket_id: order.ticket_id ?? null,
    created_at: order.created_at,
    paid_at: order.paid_at ?? null,
  };
}

function resolveActorTelegramId(db, req) {
  const botUser = resolveSessionBotUser(db, req);
  return botUser?.telegram_id != null ? botUser.telegram_id : null;
}

function auditAdminChange(db, req, { entityType, entityId, action, summary, details }) {
  try {
    logAdminAudit(db, {
      entityType,
      entityId,
      action,
      summary,
      details,
      actor: getSessionActor(req),
    });
  } catch (error) {
    console.error('[bot-admin] Audit log write failed:', error);
  }
}

function mapEnrichedActiveTicket(db, ticket) {
  const active = resolveActiveTicket(ticket);
  if (!active) return null;
  const [enriched] = enrichTicketsWithLocalData(db, [active]);
  return mapActiveTicket(enriched);
}

async function loadActiveTicketForRequest(db, req) {
  // Always scope "current active ticket" to the signed-in user's linked REGOS account,
  // never to the list's Ответственный filter.
  const activeForUserId = resolveSessionRegosUserId(db, req) || null;
  const activeTicket = activeForUserId
    ? mapEnrichedActiveTicket(
        db,
        await findLatestTicketForResponsibleUser(activeForUserId)
      )
    : null;
  return {
    active_ticket: activeTicket,
    active_ticket_user_id: activeForUserId ? Number(activeForUserId) : null,
  };
}

const CHAT_FILE_CACHE_TTL_MS = 10 * 60 * 1000;

function collectMessageFileIds(messages) {
  const ids = [];
  const seen = new Set();
  for (const message of messages || []) {
    const fileIds = Array.isArray(message?.file_ids) ? message.file_ids : [];
    for (const raw of fileIds) {
      const id = Number(raw);
      if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function toPublicChatFile(file) {
  if (!file || file.id == null) return null;
  return {
    id: file.id,
    name: file.name || null,
    extension: file.extension || null,
    mime_type: file.mime_type || null,
    media_type: file.media_type || null,
  };
}

function isSafeFileUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const CHAT_FILE_MIME_BY_EXTENSION = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  weba: 'audio/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
};

function isGenericMimeType(value) {
  const mime = String(value || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return !mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream';
}

function mimeFromChatFileExtension(file) {
  const ext = String(file?.extension || '')
    .trim()
    .replace(/^\./, '')
    .toLowerCase();
  if (ext && CHAT_FILE_MIME_BY_EXTENSION[ext]) return CHAT_FILE_MIME_BY_EXTENSION[ext];
  const name = String(file?.name || '')
    .split(/[\\/]/)
    .pop() || '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return CHAT_FILE_MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] || '';
}

function resolveChatFileContentType(file, upstreamType) {
  const declared = String(file?.mime_type || '').trim();
  if (declared && !isGenericMimeType(declared)) return declared;
  const upstream = String(upstreamType || '').trim();
  if (upstream && !isGenericMimeType(upstream)) return upstream;
  return mimeFromChatFileExtension(file) || upstream || declared || 'application/octet-stream';
}

/**
 * Fetch remote chat/recording media while following http(s) redirects.
 * `redirect: 'manual'` alone breaks CDN signed-URL hops and leaves <audio>/<video> empty.
 */
async function fetchUpstreamMedia(url, { range = '', signal, maxRedirects = 5 } = {}) {
  let current = String(url || '').trim();
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (!isSafeFileUrl(current)) {
      const error = new Error('Unsafe media URL');
      error.code = 'UNSAFE_MEDIA_URL';
      throw error;
    }
    const headers = {};
    if (/^bytes=\d*-\d*$/i.test(range)) headers.Range = range;
    const response = await fetch(current, {
      headers,
      redirect: 'manual',
      signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }
    const location = response.headers.get('location');
    if (!location) return response;
    current = new URL(location, current).href;
  }
  const error = new Error('Too many media redirects');
  error.code = 'TOO_MANY_REDIRECTS';
  throw error;
}

function writeSseEvent(res, event) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  if (res.write(frame)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('SSE connection closed'));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
  });
}

function createBotAdminRouter(db) {
  const router = express.Router();
  const publicDir = botAdminPublicDir();
  const reactUiDistDir = botAdminUiDistDir();
  const reactUiReady = isBotAdminReactUiReady();
  const recordingUrlCache = new Map();
  const chatFileCache = new Map();

  function sendBotAdminPage(res, legacyFilename) {
    if (reactUiReady) return sendBotAdminReactUiIndex(res);
    return sendPublicFile(res, publicDir, legacyFilename);
  }

  function getCachedChatFile(fileId) {
    const key = Number(fileId);
    const entry = chatFileCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      chatFileCache.delete(key);
      return null;
    }
    return entry.file;
  }

  function setCachedChatFile(file) {
    if (!file || file.id == null) return;
    chatFileCache.set(Number(file.id), {
      file,
      expiresAt: Date.now() + CHAT_FILE_CACHE_TTL_MS,
    });
  }

  async function resolveChatFiles(chatId, fileIds) {
    const unique = [...new Set((fileIds || []).map(Number).filter((id) => Number.isFinite(id) && id > 0))];
    const byId = new Map();
    const missing = [];
    for (const id of unique) {
      const cached = getCachedChatFile(id);
      if (cached) byId.set(id, cached);
      else missing.push(id);
    }
    if (missing.length) {
      const fetched = await getChatFilesByIds(chatId, missing, { includeStaffPrivate: true });
      for (const file of fetched) {
        setCachedChatFile(file);
        byId.set(Number(file.id), file);
      }
    }
    return byId;
  }

  function attachPublicFiles(messages, filesById) {
    return (messages || []).map((message) => {
      const fileIds = Array.isArray(message?.file_ids) ? message.file_ids : [];
      const files = fileIds
        .map((raw) => {
          const id = Number(raw);
          if (!Number.isFinite(id) || id <= 0) return null;
          return toPublicChatFile(filesById.get(id)) || { id };
        })
        .filter(Boolean);
      return { ...message, files };
    });
  }

  function cacheTicketRecordingUrl(ticket) {
    const url = getTicketRecordingUrl(ticket);
    if (!url || ticket?.id == null) return url;
    seedRecordingUrlCache(recordingUrlCache, ticket.id, url.href);
    return url;
  }

  function getCachedTicketRecordingUrl(ticketId) {
    const key = String(ticketId);
    const cached = recordingUrlCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      recordingUrlCache.delete(key);
      return null;
    }
    return new URL(cached.href);
  }

  function resolveRecordingUrlFromStore(ticketId) {
    const cached = getCachedTicketRecordingUrl(ticketId);
    if (cached) return cached;
    const row = getTicketRecording(db, ticketId);
    if (!row?.recording_url) return null;
    return seedRecordingUrlCache(recordingUrlCache, ticketId, row.recording_url);
  }

  router.get('/login', (_req, res) => sendBotAdminPage(res, 'login.html'));
  router.get('/login.css', (_req, res) => {
    if (reactUiReady) return res.status(404).end();
    return sendPublicFile(res, publicDir, 'login.css');
  });
  router.get('/login.js', (_req, res) => {
    if (reactUiReady) return res.status(404).end();
    return sendPublicFile(res, publicDir, 'login.js');
  });

  router.use(createKnowledgeMcpRouter(db));
  registerTaskRoutes(router, db, { auditAdminChange, buildAuditDetails });
  registerReportRoutes(router, db);

  router.get('/auth/telegram', (req, res) => {
    const creds = getAdminCredentials();
    if (!creds) {
      return res.status(503).send(
        'Admin credentials are not configured. Set BOT_ADMIN_LOGIN and BOT_ADMIN_PASSWORD in .env and restart the server.'
      );
    }

    const rawToken = String(req.query.token || '').trim();
    const lookedUp = lookupDashboardLoginToken(db, rawToken);
    if (!lookedUp) {
      return res.status(401).send(
        'Ссылка недействительна или срок её действия истёк. Запросите новую через /open_dashboard.'
      );
    }

    const telegramId = lookedUp.telegramId;
    const botUser = getBotUserByTelegramId(db, telegramId);
    if (
      !isLinkedEmployee(botUser) ||
      !hasRight(db, telegramId, 'open_admin_dashboard')
    ) {
      return res.status(403).send('Доступ запрещён. Нет права на открытие админ-панели.');
    }

    const actor = getSessionActor(req);
    const cookieMatches =
      actor?.type === 'telegram' && Number(actor.telegramId) === Number(telegramId);
    const canReuse = cookieMatches || hasActiveDashboardSession(db, telegramId);

    if (canReuse) {
      if (!lookedUp.usedAt) {
        consumeDashboardLoginToken(db, rawToken);
      }
      setSessionCookie(res, creds, { type: 'telegram', telegramId });
      return res.redirect('/bot-admin/');
    }

    const consumed = consumeDashboardLoginToken(db, rawToken);
    if (!consumed) {
      return res.status(401).send(
        'Ссылка недействительна или срок её действия истёк. Запросите новую через /open_dashboard.'
      );
    }

    setSessionCookie(res, creds, { type: 'telegram', telegramId: consumed.telegramId });
    return res.redirect('/bot-admin/');
  });

  router.post('/api/auth/telegram-webapp', express.json(), (req, res) => {
    const creds = getAdminCredentials();
    if (!creds) {
      return res.status(503).json({
        message:
          'Admin credentials are not configured. Set BOT_ADMIN_LOGIN and BOT_ADMIN_PASSWORD in .env and restart the server.',
      });
    }

    const botToken = getTelegramBotToken();
    if (!botToken) {
      return res.status(503).json({ message: 'Не задан TELEGRAM_BOT_TOKEN.' });
    }

    const parsed = parseTelegramWebAppInitData(req.body?.initData, botToken);
    if (!parsed) {
      return res.status(401).json({ message: 'Данные Telegram недействительны или устарели.' });
    }

    const { telegramId } = parsed;
    const botUser = getBotUserByTelegramId(db, telegramId);
    if (
      !isLinkedEmployee(botUser) ||
      !hasRight(db, telegramId, 'open_admin_dashboard')
    ) {
      return res.status(403).json({ message: 'Доступ запрещён. Нет права на открытие админ-панели.' });
    }

    setSessionCookie(res, creds, { type: 'telegram', telegramId });
    return res.json({ ok: true });
  });

  router.get('/api/session', (req, res) => {
    if (!getAdminCredentials()) {
      return res.status(503).json({ message: 'Admin credentials are not configured.' });
    }
    const actor = getSessionActor(req);
    if (!actor) {
      return res.status(401).json({ message: 'Требуется вход в систему.' });
    }

    let botUser = null;
    if (actor.type === 'telegram') {
      botUser = getBotUserByTelegramId(db, actor.telegramId);
    } else if (actor.type === 'user') {
      botUser = getBotUserById(db, actor.userId);
    }

    return res.json({
      ok: true,
      actor: {
        type: actor.type,
        ...(actor.type === 'telegram' ? { telegramId: actor.telegramId } : {}),
        ...(actor.type === 'user' ? { userId: actor.userId } : {}),
        ...(botUser?.regos_user_id != null
          ? { regosUserId: Number(botUser.regos_user_id) }
          : {}),
      },
      profile: buildSessionProfile(db, actor),
      permissions: getSessionPermissions(db, actor),
    });
  });

  router.patch('/api/account', requireAdminAuth, express.json(), (req, res) => {
    try {
      const botUser = resolveSessionBotUser(db, req);
      if (!botUser || botUser.role !== 'employee') {
        return res.status(403).json({
          message: 'Изменение профиля недоступно для этой учётной записи.',
        });
      }

      const displayNameProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'display_name');
      const loginProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'login');
      const newPasswordRaw = req.body?.new_password;
      const passwordProvided = newPasswordRaw !== undefined && String(newPasswordRaw) !== '';
      const canChangeCredentials = Boolean(botUser.admin_login && botUser.password_hash);

      if (!displayNameProvided && !loginProvided && !passwordProvided) {
        return res.status(400).json({
          message: 'Укажите отображаемое имя, новый логин и/или новый пароль.',
        });
      }

      if ((loginProvided || passwordProvided) && !canChangeCredentials) {
        return res.status(403).json({
          message: 'Смена логина и пароля недоступна для этой учётной записи.',
        });
      }

      if (loginProvided || passwordProvided) {
        const currentPassword = String(req.body?.current_password || '');
        if (!verifyAdminPassword(currentPassword, botUser.password_hash)) {
          return res.status(400).json({ message: 'Неверный текущий пароль.' });
        }
      }

      const updates = {};
      if (displayNameProvided) {
        updates.displayName = String(req.body.display_name || '').trim() || null;
      }
      if (loginProvided) {
        const nextLogin = String(req.body.login || '').trim();
        if (!nextLogin) {
          return res.status(400).json({ message: 'Логин не может быть пустым.' });
        }
        updates.adminLogin = nextLogin;
      }
      if (passwordProvided) {
        updates.password = String(newPasswordRaw);
      }

      try {
        updateEmployeeUser(db, botUser.id, updates);
      } catch (error) {
        if (error.message === 'LOGIN_EXISTS') {
          return res.status(409).json({ message: 'Такой логин уже занят.' });
        }
        if (error.message === 'LOGIN_REQUIRED') {
          return res.status(400).json({ message: 'Логин обязателен.' });
        }
        if (error.message === 'PASSWORD_REQUIRED') {
          return res.status(400).json({ message: 'Пароль обязателен.' });
        }
        throw error;
      }

      const updated = getBotUserById(db, botUser.id);
      const before = {
        display_name: botUser.display_name || null,
        login: botUser.admin_login || null,
        password: botUser.password_hash ? '[задано]' : null,
      };
      const after = {
        display_name: updated?.display_name || null,
        login: updated?.admin_login || null,
        password: passwordProvided ? '[изменено]' : before.password,
      };
      auditAdminChange(db, req, {
        entityType: 'account',
        entityId: botUser.id,
        action: 'update',
        summary: `Обновлён профиль: ${[
          displayNameProvided ? 'display_name' : null,
          loginProvided ? 'login' : null,
          passwordProvided ? 'password' : null,
        ]
          .filter(Boolean)
          .join(', ')}`,
        details: buildAuditDetails({
          before,
          after,
          changes: buildFieldChanges(before, after, ['display_name', 'login', 'password']),
        }),
      });
      return res.json({
        ok: true,
        profile: {
          login: updated?.admin_login || null,
          displayName: displayNameForBotUser(updated),
          canChangeCredentials: Boolean(updated?.admin_login && updated?.password_hash),
        },
      });
    } catch (error) {
      console.error('Update account error:', error);
      return res.status(500).json({ message: 'Не удалось обновить профиль.' });
    }
  });

  router.post('/api/login', express.json(), (req, res) => {
    const creds = getAdminCredentials();
    if (!creds) {
      return res.status(503).json({
        message:
          'Admin credentials are not configured. Set BOT_ADMIN_LOGIN and BOT_ADMIN_PASSWORD in .env and restart the server.',
      });
    }

    const login = String(req.body?.login || '').trim();
    const password = String(req.body?.password || '');

    if (login === creds.login && password === creds.password) {
      setSessionCookie(res, creds, { type: 'password' });
      return res.json({ ok: true });
    }

    const employee = findEmployeeByAdminLogin(db, login);
    if (employee && verifyAdminPassword(password, employee.password_hash)) {
      setSessionCookie(res, creds, { type: 'user', userId: employee.id });
      return res.json({ ok: true });
    }

    return res.status(401).json({ message: 'Неверный логин или пароль.' });
  });

  router.post('/api/logout', (req, res) => {
    const actor = getSessionActor(req);
    if (actor?.type === 'telegram' && actor.telegramId) {
      invalidateDashboardLoginTokensForTelegramId(db, actor.telegramId);
    }
    clearSessionCookie(res);
    return res.json({ ok: true });
  });

  router.get('/rights-meta', requireRight(db, 'users_read'), (_req, res) => {
    res.json({
      rights: Object.entries(RIGHTS).map(([key, value]) => ({
        key,
        label: value.label,
      })),
    });
  });

  router.get('/api/users', requireRight(db, 'users_read'), (req, res) => {
    const role = String(req.query.role || '').trim();
    const query = String(req.query.q || '').trim();
    let { page, limit, offset } = parsePaginationQuery(req);
    const options = { offset, limit };
    if (role === 'employee' || role === 'customer') {
      options.role = role;
    }
    if (query) {
      options.query = query;
    }
    let result = listBotUsers(db, options);
    const totalPages = Math.max(1, Math.ceil(result.total / limit) || 1);
    if (page > totalPages) {
      page = totalPages;
      options.offset = (page - 1) * limit;
      result = listBotUsers(db, options);
    }
    res.json({
      users: result.users.map(mapUserResponse),
      total: result.total,
      page,
      limit,
    });
  });

  router.get('/api/order-logs', requireRight(db, 'order_logs_read'), (req, res) => {
    const query = String(req.query.q || '').trim();
    let { page, limit, offset } = parsePaginationQuery(req);
    let result = listOrderLogs(db, { query: query || undefined, offset, limit });
    const totalPages = Math.max(1, Math.ceil(result.total / limit) || 1);
    if (page > totalPages) {
      page = totalPages;
      offset = (page - 1) * limit;
      result = listOrderLogs(db, { query: query || undefined, offset, limit });
    }
    res.json({
      logs: result.logs.map(mapOrderLogRow),
      total: result.total,
      page,
      limit,
    });
  });

  router.get('/api/logs', requireRight(db, 'logs_read'), (req, res) => {
    const query = String(req.query.q || '').trim();
    let { page, limit, offset } = parsePaginationQuery(req);
    let result = listAdminAuditLogs(db, { query: query || undefined, offset, limit });
    const totalPages = Math.max(1, Math.ceil(result.total / limit) || 1);
    if (page > totalPages) {
      page = totalPages;
      offset = (page - 1) * limit;
      result = listAdminAuditLogs(db, { query: query || undefined, offset, limit });
    }
    res.json({
      logs: result.logs.map(mapAdminAuditLogRow),
      total: result.total,
      page,
      limit,
    });
  });

  router.get('/api/tickets/events', requireRight(db, 'tickets_read'), (req, res) => {
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const unsubscribe = ticketEventHub.subscribe((event) => writeSseEvent(res, event));
    const heartbeat = setInterval(() => {
      writeSseEvent(res, {
        type: 'heartbeat',
        occurred_at: new Date().toISOString(),
      }).catch(() => {});
    }, 30_000);

    res.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  router.get('/api/tickets/active', requireRight(db, 'tickets_read'), async (req, res) => {
    try {
      return res.json(await loadActiveTicketForRequest(db, req));
    } catch (error) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status).json({ message: error.message });
      }
      console.error('Load active ticket error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить активный тикет.' });
    }
  });

  router.get('/api/tickets/users', requireRight(db, 'tickets_read'), async (_req, res) => {
    try {
      const users = await fetchAllUsers();
      users.sort((a, b) =>
        String(a.full_name || a.login || '').localeCompare(
          String(b.full_name || b.login || ''),
          'ru'
        )
      );
      return res.json({
        users: users.map((user) => ({
          id: user.id,
          full_name: user.full_name || null,
          login: user.login || null,
          first_name: user.first_name || null,
          last_name: user.last_name || null,
        })),
      });
    } catch (error) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status).json({ message: error.message });
      }
      console.error('List ticket users error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить пользователей REGOS.' });
    }
  });

  router.get('/api/tickets/channels', requireRight(db, 'tickets_read'), async (_req, res) => {
    try {
      const channels = await fetchAllChannels();
      channels.sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), 'ru')
      );
      return res.json({
        channels: channels.map(mapRegosChannelSummary),
      });
    } catch (error) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status).json({ message: error.message });
      }
      console.error('List ticket channels error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить каналы REGOS.' });
    }
  });

  router.get('/api/tickets/clients', requireRight(db, 'tickets_read'), async (req, res) => {
    try {
      const query = String(req.query.q || '').trim();
      if (query.length < 2) {
        return res.json({ clients: [] });
      }
      const clients = await searchClients(query, { limit: 20 });
      return res.json({
        clients: clients.map((client) => ({
          id: client.id,
          name: client.name || null,
          phone: client.phone || null,
          email: client.email || null,
          external_id: client.external_id || null,
          photo_url: client.photo_url || null,
        })),
      });
    } catch (error) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status).json({ message: error.message });
      }
      console.error('Search ticket clients error:', error);
      return res.status(500).json({ message: 'Не удалось найти клиентов REGOS.' });
    }
  });

  function mapAdminClient(client) {
    if (!client) return null;
    return {
      id: client.id,
      name: client.name || null,
      phone: client.phone || null,
      email: client.email || null,
      external_id: client.external_id || null,
      description: client.description || null,
      photo_url: client.photo_url || null,
    };
  }

  function mapAdminFirmLink(link) {
    if (!link) return null;
    return {
      id: link.id,
      firm_type: link.firm_type,
      firm_record_id: link.firm_record_id,
      firm_name: link.firm_name,
      firm_phone: link.firm_phone,
      firm_message: link.firm_message,
      created_at: link.created_at,
    };
  }

  router.get('/api/clients/:id', requireRight(db, 'tickets_read'), async (req, res) => {
    try {
      const client = await getClientById(req.params.id);
      if (!client) {
        return res.status(404).json({ message: 'Клиент не найден.' });
      }
      const firms = listLinksByClient(db, client.id).map(mapAdminFirmLink);
      return res.json({ client: mapAdminClient(client), firms });
    } catch (error) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status).json({ message: error.message });
      }
      if (error?.code === 'INVALID_CLIENT_ID') {
        return res.status(400).json({ message: 'Некорректный ID клиента.' });
      }
      console.error('Get client error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить клиента.' });
    }
  });

  router.patch(
    '/api/clients/:id',
    requireRight(db, 'clients_edit'),
    express.json(),
    async (req, res) => {
      try {
        const clientId = Number(req.params.id);
        const current = await getClientById(clientId);
        if (!current) {
          return res.status(404).json({ message: 'Клиент не найден.' });
        }

        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const changes = {};
        for (const key of ['name', 'phone', 'email', 'description', 'external_id']) {
          if (Object.hasOwn(body, key) && String(body[key] ?? '') !== String(current[key] ?? '')) {
            changes[key] = body[key];
          }
        }

        await editClient(clientId, changes);
        const client = await getClientById(clientId);
        if (!client) {
          return res.status(502).json({
            message: 'REGOS изменил клиента, но не вернул его при повторном чтении.',
          });
        }
        const firms = listLinksByClient(db, client.id).map(mapAdminFirmLink);
        const before = {};
        const after = {};
        for (const key of Object.keys(changes)) {
          before[key] = current[key] ?? null;
          after[key] = client[key] ?? changes[key] ?? null;
        }
        auditAdminChange(db, req, {
          entityType: 'client',
          entityId: clientId,
          action: 'update',
          summary: `Изменён клиент #${clientId}`,
          details: buildAuditDetails({ before, after }),
        });
        return res.json({ client: mapAdminClient(client), firms });
      } catch (error) {
        if (error instanceof RegosCrmError) {
          return res.status(error.status).json({ message: error.message });
        }
        console.error('Edit client error:', error);
        return res.status(500).json({ message: 'Не удалось изменить клиента.' });
      }
    }
  );

  router.post(
    '/api/clients/:id/firms',
    requireRight(db, 'clients_link_firm'),
    express.json(),
    (req, res) => {
      try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const link = addClientFirmLink(db, {
          regos_client_id: req.params.id,
          type: body.type,
          recordId: body.recordId,
          clientName: body.clientName,
          phone: body.phone,
          message: body.message,
        });
        auditAdminChange(db, req, {
          entityType: 'firm_link',
          entityId: link?.id,
          action: 'create',
          summary: `Привязана фирма к клиенту #${req.params.id}`,
          details: buildAuditDetails({
            before: null,
            after: {
              regos_client_id: req.params.id,
              type: body.type ?? null,
              record_id: body.recordId ?? null,
              client_name: body.clientName ?? null,
              phone: body.phone ?? null,
            },
          }),
        });
        return res.status(201).json({ firm: mapAdminFirmLink(link) });
      } catch (error) {
        if (error?.code === 'DUPLICATE_LINK') {
          return res.status(409).json({ message: 'Эта фирма уже привязана к клиенту.' });
        }
        if (
          error?.code === 'INVALID_CLIENT_ID' ||
          error?.code === 'INVALID_FIRM_TYPE' ||
          error?.code === 'INVALID_FIRM_RECORD_ID'
        ) {
          return res.status(400).json({ message: 'Укажите корректные данные фирмы.' });
        }
        console.error('Add client firm link error:', error);
        return res.status(500).json({ message: 'Не удалось привязать фирму.' });
      }
    }
  );

  router.delete(
    '/api/clients/:id/firms/:linkId',
    requireRight(db, 'clients_link_firm'),
    (req, res) => {
      try {
        const existing = getLinkById(db, req.params.linkId);
        if (!existing || Number(existing.regos_client_id) !== Number(req.params.id)) {
          return res.status(404).json({ message: 'Связь с фирмой не найдена.' });
        }
        const removed = removeClientFirmLink(db, req.params.linkId, {
          regosClientId: req.params.id,
        });
        if (!removed) {
          return res.status(404).json({ message: 'Связь с фирмой не найдена.' });
        }
        auditAdminChange(db, req, {
          entityType: 'firm_link',
          entityId: req.params.linkId,
          action: 'delete',
          summary: `Отвязана фирма от клиента #${req.params.id}`,
          details: buildAuditDetails({
            before: {
              regos_client_id: existing.regos_client_id ?? req.params.id,
              type: existing.type ?? null,
              record_id: existing.record_id ?? null,
              client_name: existing.client_name ?? null,
              phone: existing.phone ?? null,
            },
            after: null,
          }),
        });
        return res.json({ ok: true });
      } catch (error) {
        if (error?.code === 'INVALID_CLIENT_ID') {
          return res.status(400).json({ message: 'Некорректный ID клиента.' });
        }
        console.error('Remove client firm link error:', error);
        return res.status(500).json({ message: 'Не удалось отвязать фирму.' });
      }
    }
  );

  router.post(
    '/api/tickets',
    requireRight(db, 'tickets_create'),
    express.json(),
    async (req, res) => {
      try {
        const created = await createTicket({
          client_id: req.body?.client_id,
          channel_id: req.body?.channel_id,
          direction: req.body?.direction,
          subject: req.body?.subject,
          description: req.body?.description,
          responsible_user_id: req.body?.responsible_user_id,
        });

        const body = req.body && typeof req.body === 'object' ? req.body : {};
        let participantIds = null;
        if (Object.hasOwn(body, 'participant_user_ids')) {
          participantIds = normalizeParticipantUserIds(body.participant_user_ids);
          await setTicketParticipants(created.id, participantIds, { replaceMode: true });
        }

        const ticket = await findTicketById(created.id);
        if (!ticket) {
          return res.status(502).json({
            message: 'REGOS создал тикет, но не вернул его при повторном чтении.',
            ticket_id: created.id,
          });
        }
        cacheTicketRecordingUrl(ticket);
        auditAdminChange(db, req, {
          entityType: 'ticket',
          entityId: created.id,
          action: 'create',
          summary: `Создан тикет #${created.id}`,
          details: buildAuditDetails({
            before: null,
            after: {
              id: created.id,
              client_id: req.body?.client_id ?? null,
              channel_id: req.body?.channel_id ?? null,
              subject: req.body?.subject ?? null,
              direction: req.body?.direction ?? null,
              responsible_user_id: req.body?.responsible_user_id ?? null,
              participant_user_ids: participantIds,
            },
          }),
        });
        return res.status(201).json({ ticket });
      } catch (error) {
        if (error instanceof RegosCrmError) {
          return res.status(error.status).json({ message: error.message });
        }
        console.error('Create ticket error:', error);
        return res.status(500).json({ message: 'Не удалось создать тикет.' });
      }
    }
  );

  router.patch(
    '/api/tickets/:id',
    requireRight(db, 'tickets_edit'),
    express.json(),
    async (req, res) => {
      try {
        const current = await findTicketById(req.params.id);
        if (!current) {
          return res.status(404).json({ message: 'Тикет не найден.' });
        }

        if (
          String(current.status || '') === 'Closed' &&
          !actorHasPermission(db, getSessionActor(req), 'tickets_edit_closed')
        ) {
          return res.status(403).json({
            message: 'Недостаточно прав для изменения закрытого тикета.',
          });
        }

        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const scalarChanges = {};
        for (const key of ['subject', 'description', 'direction']) {
          if (Object.hasOwn(body, key) && String(body[key] ?? '') !== String(current[key] ?? '')) {
            scalarChanges[key] = body[key];
          }
        }

        await editTicket(current.id, scalarChanges);
        if (
          Object.hasOwn(body, 'responsible_user_id') &&
          Number(body.responsible_user_id) !== Number(current.responsible_user_id)
        ) {
          await setTicketResponsible(current.id, body.responsible_user_id);
        }
        if (
          Object.hasOwn(body, 'status') &&
          String(body.status || '') !== String(current.status || '')
        ) {
          await setTicketStatus(current.id, body.status);
        }

        let nextParticipantIds = null;
        let participantsChanged = false;
        if (Object.hasOwn(body, 'participant_user_ids')) {
          nextParticipantIds = normalizeParticipantUserIds(body.participant_user_ids);
          if (!participantUserIdsEqual(nextParticipantIds, current.participant_user_ids)) {
            await setTicketParticipants(current.id, nextParticipantIds, { replaceMode: true });
            participantsChanged = true;
          }
        }

        const ticket = await findTicketById(current.id);
        if (!ticket) {
          return res.status(502).json({
            message: 'REGOS изменил тикет, но не вернул его при повторном чтении.',
          });
        }
        cacheTicketRecordingUrl(ticket);
        const before = {};
        const after = {};
        for (const key of Object.keys(scalarChanges)) {
          before[key] = current[key] ?? null;
          after[key] = ticket[key] ?? scalarChanges[key] ?? null;
        }
        if (
          Object.hasOwn(body, 'responsible_user_id') &&
          Number(body.responsible_user_id) !== Number(current.responsible_user_id)
        ) {
          before.responsible_user_id = current.responsible_user_id ?? null;
          after.responsible_user_id = ticket.responsible_user_id ?? body.responsible_user_id ?? null;
        }
        if (
          Object.hasOwn(body, 'status') &&
          String(body.status || '') !== String(current.status || '')
        ) {
          before.status = current.status ?? null;
          after.status = ticket.status ?? body.status ?? null;
        }
        if (participantsChanged) {
          before.participant_user_ids = normalizeParticipantUserIds(current.participant_user_ids);
          const refreshed = normalizeParticipantUserIds(ticket.participant_user_ids);
          after.participant_user_ids = refreshed.length ? refreshed : nextParticipantIds;
        }
        auditAdminChange(db, req, {
          entityType: 'ticket',
          entityId: current.id,
          action: 'update',
          summary: `Изменён тикет #${current.id}`,
          details: buildAuditDetails({ before, after }),
        });
        // Push list refresh immediately; do not wait for REGOS webhook round-trip.
        ticketEventHub.publish({
          type: 'ticket_changed',
          ticket_id: ticket.id,
          responsible_user_id: ticket.responsible_user_id ?? null,
          source_action: 'TicketEdited',
          occurred_at: Date.now(),
        });
        return res.json({ ticket });
      } catch (error) {
        if (error instanceof RegosCrmError) {
          return res.status(error.status).json({ message: error.message });
        }
        console.error('Edit ticket error:', error);
        return res.status(500).json({ message: 'Не удалось изменить тикет.' });
      }
    }
  );

  router.get('/api/settings/channels', requireRight(db, 'settings_read'), async (_req, res) => {
    try {
      return res.json({ channels: await loadMergedChannelSettings(db) });
    } catch (error) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status).json({ message: error.message });
      }
      console.error('Load channel settings error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить настройки каналов.' });
    }
  });

  router.put(
    '/api/settings/channels',
    requireRight(db, 'settings_edit'),
    express.json(),
    async (req, res) => {
      try {
        const current = await loadMergedChannelSettings(db);
        const submitted = Array.isArray(req.body?.channels) ? req.body.channels : null;
        if (!submitted) {
          return res.status(400).json({ message: 'Передайте полный список каналов.' });
        }

        const submittedById = new Map(
          submitted.map((item) => [String(item?.id ?? item?.channel_id ?? '').trim(), item])
        );
        if (
          submitted.length !== current.length ||
          submittedById.size !== current.length ||
          current.some((channel) => !submittedById.has(channel.id))
        ) {
          return res.status(400).json({ message: 'Список каналов устарел. Обновите страницу.' });
        }

        const saved = replaceRegosChannelSettings(
          db,
          current.map((channel) => ({
            channel_id: channel.id,
            channel_name: channel.name,
            interaction_mode: submittedById.get(channel.id)?.interaction_mode,
          }))
        );
        const savedById = new Map(saved.map((setting) => [String(setting.channel_id), setting]));
        const beforeModes = {};
        const afterModes = {};
        for (const channel of current) {
          const nextMode =
            savedById.get(channel.id)?.interaction_mode ||
            submittedById.get(channel.id)?.interaction_mode ||
            channel.interaction_mode ||
            'message_only';
          if (String(channel.interaction_mode || '') !== String(nextMode || '')) {
            beforeModes[channel.id] = channel.interaction_mode || null;
            afterModes[channel.id] = nextMode;
          }
        }
        auditAdminChange(db, req, {
          entityType: 'channel_settings',
          entityId: null,
          action: 'update',
          summary: `Обновлены настройки каналов (${Object.keys(afterModes).length || saved.length})`,
          details: buildAuditDetails({
            before: beforeModes,
            after: afterModes,
          }),
        });
        return res.json({
          ok: true,
          channels: current.map((channel) => ({
            ...channel,
            interaction_mode:
              savedById.get(channel.id)?.interaction_mode || 'message_only',
          })),
        });
      } catch (error) {
        if (
          [
            'INVALID_CHANNEL_ID',
            'INVALID_CHANNEL_MODE',
            'INVALID_CHANNEL_NAME',
            'INVALID_CHANNEL_SETTINGS',
            'DUPLICATE_CHANNEL_ID',
          ].includes(error.message)
        ) {
          return res.status(400).json({ message: 'Некорректные настройки каналов.' });
        }
        if (error instanceof RegosCrmError) {
          return res.status(error.status).json({ message: error.message });
        }
        console.error('Save channel settings error:', error);
        return res.status(500).json({ message: 'Не удалось сохранить настройки каналов.' });
      }
    }
  );

  router.get('/api/settings/telegram-tickets', requireRight(db, 'settings_read'), async (_req, res) => {
    try {
      const settings = serializeTelegramTicketSettings(loadTelegramTicketSettings(db));
      let channels = [];
      let users = [];
      try {
        channels = (await fetchAllChannels())
          .map(mapRegosChannelSummary)
          .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'));
      } catch (error) {
        console.error('Load telegram-ticket channels error:', error);
      }
      try {
        users = (await fetchAllUsers())
          .map((user) => ({
            id: user.id,
            full_name: user.full_name || null,
            login: user.login || null,
            first_name: user.first_name || null,
            last_name: user.last_name || null,
          }))
          .sort((a, b) =>
            String(a.full_name || a.login || '').localeCompare(
              String(b.full_name || b.login || ''),
              'ru'
            )
          );
      } catch (error) {
        console.error('Load telegram-ticket users error:', error);
      }
      return res.json({ settings, channels, users });
    } catch (error) {
      console.error('Load telegram ticket settings error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить настройки Telegram-тикетов.' });
    }
  });

  router.put(
    '/api/settings/telegram-tickets',
    requireRight(db, 'settings_edit'),
    express.json(),
    (req, res) => {
      try {
        const before = loadTelegramTicketSettings(db);
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const saved = saveTelegramTicketSettings(db, {
          enabled: body.enabled,
          channelId: body.channel_id ?? body.channelId,
          direction: body.direction,
          responsibleUserId: body.responsible_user_id ?? body.responsibleUserId,
          participantUserIds: body.participant_user_ids ?? body.participantUserIds,
          subject: body.subject,
          fallbackClientId: body.fallback_client_id ?? body.fallbackClientId,
        });
        auditAdminChange(db, req, {
          entityType: 'telegram_ticket_settings',
          entityId: null,
          action: 'update',
          summary: 'Обновлены настройки Telegram-тикетов',
          details: buildAuditDetails({
            before: serializeTelegramTicketSettings(before),
            after: serializeTelegramTicketSettings(saved),
          }),
        });
        return res.json({
          ok: true,
          settings: serializeTelegramTicketSettings(saved),
        });
      } catch (error) {
        if (
          error.message === 'TELEGRAM_TICKET_CHANNEL_REQUIRED' ||
          error.message === 'INVALID_TELEGRAM_TICKET_CHANNEL' ||
          error.message === 'INVALID_TELEGRAM_TICKET_DIRECTION' ||
          error.message === 'INVALID_TELEGRAM_TICKET_RESPONSIBLE' ||
          error.message === 'INVALID_TELEGRAM_TICKET_PARTICIPANTS' ||
          error.message === 'INVALID_TELEGRAM_TICKET_SUBJECT' ||
          error.message === 'INVALID_TELEGRAM_TICKET_FALLBACK_CLIENT'
        ) {
          const messages = {
            TELEGRAM_TICKET_CHANNEL_REQUIRED: 'Укажите канал REGOS для Telegram-тикетов.',
            INVALID_TELEGRAM_TICKET_CHANNEL: 'Некорректный канал REGOS.',
            INVALID_TELEGRAM_TICKET_DIRECTION: 'Направление должно быть Inbound или Outbound.',
            INVALID_TELEGRAM_TICKET_RESPONSIBLE: 'Некорректный ответственный пользователь.',
            INVALID_TELEGRAM_TICKET_PARTICIPANTS: 'Некорректный список участников.',
            INVALID_TELEGRAM_TICKET_SUBJECT: 'Некорректная тема тикета.',
            INVALID_TELEGRAM_TICKET_FALLBACK_CLIENT: 'Некорректный fallback-клиент.',
          };
          return res.status(400).json({ message: messages[error.message] || 'Некорректные настройки.' });
        }
        console.error('Save telegram ticket settings error:', error);
        return res.status(500).json({ message: 'Не удалось сохранить настройки Telegram-тикетов.' });
      }
    }
  );

  router.get(
    '/api/settings/telegram-tickets/clients',
    requireRight(db, 'settings_read'),
    async (req, res) => {
      try {
        const query = String(req.query.q || '').trim();
        if (query.length < 2) {
          return res.json({ clients: [] });
        }
        const clients = await searchClients(query, { limit: 20 });
        return res.json({
          clients: clients.map((client) => ({
            id: client.id,
            name: client.name || null,
            phone: client.phone || null,
            email: client.email || null,
          })),
        });
      } catch (error) {
        if (error instanceof RegosCrmError) {
          return res.status(error.status).json({ message: error.message });
        }
        console.error('Search telegram-ticket clients error:', error);
        return res.status(500).json({ message: 'Не удалось найти клиентов REGOS.' });
      }
    }
  );

  router.get('/api/settings/ai', requireRight(db, 'settings_read'), (_req, res) => {
    try {
      return res.json(serializeAiSettings(loadAiSettings(db)));
    } catch (error) {
      console.error('Load AI settings error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить настройки AI.' });
    }
  });

  router.put('/api/settings/ai', requireRight(db, 'settings_edit'), express.json(), (req, res) => {
    try {
      const before = loadAiSettings(db);
      const patch = {
        enabled: req.body?.enabled,
        testMode: req.body?.test_mode ?? req.body?.testMode,
        provider: req.body?.provider,
        model: req.body?.model,
        agentModels: req.body?.agent_models ?? req.body?.agentModels,
        transcribeModel: req.body?.transcribe_model ?? req.body?.transcribeModel,
        reasoningEffort: req.body?.reasoning_effort ?? req.body?.reasoningEffort,
        historyLimit: req.body?.history_limit ?? req.body?.historyLimit,
        customerRepliesPerHour:
          req.body?.customer_replies_per_hour ?? req.body?.customerRepliesPerHour,
        customerRepliesPerTicket:
          req.body?.customer_replies_per_ticket ?? req.body?.customerRepliesPerTicket,
        groupChatId: req.body?.group_chat_id ?? req.body?.groupChatId,
        groupTopics: req.body?.group_topics ?? req.body?.groupTopics,
        disabledTools: req.body?.disabled_tools ?? req.body?.disabledTools,
        disabledAgentTools: req.body?.disabled_agent_tools ?? req.body?.disabledAgentTools,
        ignoredCustomerMessages:
          req.body?.ignored_customer_messages ?? req.body?.ignoredCustomerMessages,
      };
      if (
        Object.prototype.hasOwnProperty.call(req.body || {}, 'openai_api_key') ||
        Object.prototype.hasOwnProperty.call(req.body || {}, 'openaiApiKey')
      ) {
        patch.openaiApiKey = req.body?.openai_api_key ?? req.body?.openaiApiKey;
      }
      if (
        Object.prototype.hasOwnProperty.call(req.body || {}, 'openai_base_url') ||
        Object.prototype.hasOwnProperty.call(req.body || {}, 'openaiBaseUrl')
      ) {
        patch.openaiBaseUrl = req.body?.openai_base_url ?? req.body?.openaiBaseUrl;
      }
      if (
        Object.prototype.hasOwnProperty.call(req.body || {}, 'gemini_api_key') ||
        Object.prototype.hasOwnProperty.call(req.body || {}, 'geminiApiKey')
      ) {
        patch.geminiApiKey = req.body?.gemini_api_key ?? req.body?.geminiApiKey;
      }
      const saved = saveAiSettings(db, patch);
      auditAdminChange(db, req, {
        entityType: 'ai_settings',
        entityId: null,
        action: 'update',
        summary: 'Обновлены настройки AI',
        details: buildAuditDetails({
          before: serializeAiSettings(before),
          after: serializeAiSettings(saved),
        }),
      });
      return res.json({ ok: true, ...serializeAiSettings(saved) });
    } catch (error) {
      if (
        error.message === 'INVALID_AI_PROVIDER' ||
        error.message === 'INVALID_AI_MODEL' ||
        error.message === 'INVALID_AI_AGENT_MODELS' ||
        error.message === 'INVALID_AI_TRANSCRIBE_MODEL' ||
        error.message === 'INVALID_AI_REASONING_EFFORT' ||
        error.message === 'INVALID_AI_HISTORY_LIMIT' ||
        error.message === 'INVALID_AI_CUSTOMER_REPLY_LIMIT' ||
        error.message === 'INVALID_AI_GROUP_CHAT_ID' ||
        error.message === 'INVALID_AI_GROUP_TOPICS' ||
        error.message === 'INVALID_AI_DISABLED_TOOLS' ||
        error.message === 'INVALID_AI_IGNORED_CUSTOMER_MESSAGES' ||
        error.message === 'INVALID_AI_API_KEY' ||
        error.message === 'INVALID_AI_BASE_URL'
      ) {
        return res.status(400).json({ message: 'Некорректные настройки AI.' });
      }
      console.error('Save AI settings error:', error);
      return res.status(500).json({ message: 'Не удалось сохранить настройки AI.' });
    }
  });

  router.post('/api/settings/ai/group-test', requireRight(db, 'settings_edit'), express.json(), async (req, res) => {
    const topicKey = String(req.body?.topic_key || req.body?.topicKey || '').trim();
    const message = String(req.body?.message || '').trim();
    try {
      const result = await notifyGroupTopic(db, {
        topicKey,
        message: message ? `Тест из bot-admin:\n\n${message}` : '',
      });
      if (!result.ok) {
        const error = result.error || 'notify_failed';
        const status =
          error === 'not_configured' || error === 'unknown_topic' || error === 'empty_message'
            ? 400
            : error === 'no_bot'
              ? 503
              : 502;
        const messages = {
          not_configured: 'Сначала сохраните ID группы и хотя бы одну тему.',
          unknown_topic: 'Тема не найдена в сохранённом списке.',
          empty_message: 'Введите текст сообщения.',
          no_bot: 'Не задан TELEGRAM_BOT_TOKEN.',
        };
        return res.status(status).json({
          ok: false,
          error,
          message: messages[error] || `Не удалось отправить: ${error}`,
        });
      }
      auditAdminChange(db, req, {
        entityType: 'ai_group_topic',
        entityId: result.topic_key,
        action: 'test',
        summary: `Тестовое сообщение в тему ${result.topic_name || result.topic_key}`,
        details: buildAuditDetails({
          topic_key: result.topic_key,
          topic_name: result.topic_name,
        }),
      });
      return res.json({
        ok: true,
        topic_key: result.topic_key,
        topic_name: result.topic_name,
      });
    } catch (error) {
      console.error('Test AI group topic error:', error);
      return res.status(500).json({ message: 'Не удалось отправить тестовое сообщение.' });
    }
  });

  router.get('/api/settings/ai/tools', requireRight(db, 'settings_read'), (_req, res) => {
    try {
      return res.json({ tools: listToolSchemas({ db }) });
    } catch (error) {
      console.error('List AI tools error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить инструменты.' });
    }
  });

  router.post('/api/settings/ai/tools/test', requireRight(db, 'settings_edit'), express.json(), async (req, res) => {
    const toolName = String(req.body?.tool_name || req.body?.toolName || '').trim();
    const ticketId = req.body?.ticket_id ?? req.body?.ticketId ?? null;
    let args = req.body?.arguments ?? req.body?.args ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        return res.status(400).json({ ok: false, error: 'invalid_arguments', message: 'Аргументы должны быть JSON-объектом.' });
      }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return res.status(400).json({ ok: false, error: 'invalid_arguments', message: 'Аргументы должны быть JSON-объектом.' });
    }

    try {
      const result = await runAgentToolTest({
        db,
        toolName,
        args,
        ticketId,
        deps: {
          findTicketById,
          getChatFilesByIds,
        },
      });
      if (!result.ok) {
        const status =
          result.error === 'unknown_tool' ||
          result.error === 'ticket_required' ||
          result.error === 'invalid_arguments'
            ? 400
            : result.error === 'ticket_not_found'
              ? 404
              : result.error === 'execute_failed'
                ? 500
                : 400;
        return res.status(status).json(result);
      }
      auditAdminChange(db, req, {
        entityType: 'ai_tool',
        entityId: toolName,
        action: 'test',
        summary: `Тест инструмента ${toolName}`,
        details: buildAuditDetails({
          tool_name: toolName,
          ticket_id: ticketId,
          duration_ms: result.duration_ms,
        }),
      });
      return res.json(result);
    } catch (error) {
      console.error('Test AI tool error:', error);
      return res.status(500).json({ ok: false, error: 'execute_failed', message: 'Не удалось выполнить инструмент.' });
    }
  });

  function respondPromptWriteError(res, error, fallbackMessage) {
    if (error.message === 'PROMPT_NOT_FOUND' || error.message === 'INVALID_PROMPT_SLUG') {
      return res.status(404).json({ message: 'Промпт не найден.' });
    }
    if (error.message === 'INVALID_PROMPT_BODY' || error.message === 'INVALID_PROMPT_NAME') {
      return res.status(400).json({ message: 'Некорректные данные промпта.' });
    }
    console.error(fallbackMessage, error);
    return res.status(500).json({ message: fallbackMessage });
  }

  router.get('/api/ai/prompts', requireRight(db, 'settings_read'), (_req, res) => {
    try {
      return res.json({ types: listPromptTypes(db) });
    } catch (error) {
      console.error('List AI prompts error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить промпты.' });
    }
  });

  router.post('/api/ai/prompts', requireRight(db, 'settings_edit'), express.json(), (req, res) => {
    try {
      const prompt = createPrompt(
        db,
        { type: req.body?.type, name: req.body?.name, body: req.body?.body },
        { updatedBy: resolveKnowledgeActorUserId(req) }
      );
      auditAdminChange(db, req, {
        entityType: 'ai_prompt',
        entityId: prompt.id,
        action: 'create',
        summary: `Создан промпт «${prompt.name}»`,
        details: buildAuditDetails({ before: null, after: prompt }),
      });
      return res.status(201).json({ prompt });
    } catch (error) {
      return respondPromptWriteError(res, error, 'Не удалось создать промпт.');
    }
  });

  router.put('/api/ai/prompts/active', requireRight(db, 'settings_edit'), express.json(), (req, res) => {
    try {
      const prompt = setActivePrompt(db, req.body?.type, req.body?.prompt_id);
      auditAdminChange(db, req, {
        entityType: 'ai_prompt',
        entityId: prompt.id ?? `${prompt.type}:default`,
        action: 'update',
        summary: prompt.is_default
          ? `Включён промпт по умолчанию «${prompt.type}»`
          : `Включён промпт «${prompt.name}»`,
        details: buildAuditDetails({ after: prompt }),
      });
      return res.json({ prompt });
    } catch (error) {
      return respondPromptWriteError(res, error, 'Не удалось включить промпт.');
    }
  });

  router.put('/api/ai/prompts/:id', requireRight(db, 'settings_edit'), express.json(), (req, res) => {
    try {
      const before = getPrompt(db, req.params.id);
      const prompt = updatePrompt(
        db,
        req.params.id,
        { name: req.body?.name, body: req.body?.body },
        { updatedBy: resolveKnowledgeActorUserId(req) }
      );
      auditAdminChange(db, req, {
        entityType: 'ai_prompt',
        entityId: prompt.id,
        action: 'update',
        summary: `Изменён промпт «${prompt.name}»`,
        details: buildAuditDetails({ before, after: prompt }),
      });
      return res.json({ prompt });
    } catch (error) {
      return respondPromptWriteError(res, error, 'Не удалось сохранить промпт.');
    }
  });

  router.delete('/api/ai/prompts/:id', requireRight(db, 'settings_edit'), (req, res) => {
    try {
      const before = getPrompt(db, req.params.id);
      const prompt = deletePrompt(db, req.params.id);
      auditAdminChange(db, req, {
        entityType: 'ai_prompt',
        entityId: before.id,
        action: 'delete',
        summary: `Удалён промпт «${before.name}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true, prompt });
    } catch (error) {
      return respondPromptWriteError(res, error, 'Не удалось удалить промпт.');
    }
  });

  function respondToolDescriptionWriteError(res, error, fallbackMessage) {
    if (error.message === 'UNKNOWN_TOOL') {
      return res.status(404).json({ message: 'Инструмент не найден.' });
    }
    if (error.message === 'INVALID_TOOL_DESCRIPTION') {
      return res.status(400).json({ message: 'Некорректное описание инструмента.' });
    }
    console.error(fallbackMessage, error);
    return res.status(500).json({ message: fallbackMessage });
  }

  router.get('/api/ai/tool-descriptions', requireRight(db, 'settings_read'), (_req, res) => {
    try {
      return res.json({ tools: listToolDescriptions(db) });
    } catch (error) {
      console.error('List AI tool descriptions error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить описания инструментов.' });
    }
  });

  router.put('/api/ai/tool-descriptions/:name', requireRight(db, 'settings_edit'), express.json(), (req, res) => {
    try {
      const before = getToolDescription(db, req.params.name);
      const tool = saveToolDescription(db, req.params.name, req.body?.body, {
        updatedBy: resolveKnowledgeActorUserId(req),
      });
      auditAdminChange(db, req, {
        entityType: 'ai_tool_description',
        entityId: tool.name,
        action: 'update',
        summary: `Изменено описание инструмента «${tool.title}»`,
        details: buildAuditDetails({ before, after: tool }),
      });
      return res.json({ tool });
    } catch (error) {
      return respondToolDescriptionWriteError(res, error, 'Не удалось сохранить описание инструмента.');
    }
  });

  router.delete('/api/ai/tool-descriptions/:name', requireRight(db, 'settings_edit'), (req, res) => {
    try {
      const before = getToolDescription(db, req.params.name);
      const tool = resetToolDescription(db, req.params.name);
      auditAdminChange(db, req, {
        entityType: 'ai_tool_description',
        entityId: before.name,
        action: 'delete',
        summary: `Сброшено описание инструмента «${before.title}»`,
        details: buildAuditDetails({ before, after: tool }),
      });
      return res.json({ ok: true, tool });
    } catch (error) {
      return respondToolDescriptionWriteError(res, error, 'Не удалось сбросить описание инструмента.');
    }
  });

  function respondPromptVariableWriteError(res, error, fallbackMessage) {
    if (error.message === 'VARIABLE_NOT_FOUND') {
      return res.status(404).json({ message: 'Переменная не найдена.' });
    }
    if (error.message === 'INVALID_VARIABLE_KEY') {
      return res.status(400).json({ message: 'Ключ переменной: латиница, цифры и _, начинается с буквы.' });
    }
    if (error.message === 'INVALID_VARIABLE_NAME') {
      return res.status(400).json({ message: 'Некорректное название переменной.' });
    }
    if (error.message === 'INVALID_VARIABLE_SOURCE') {
      return res.status(400).json({ message: 'Введите тело JavaScript-функции.' });
    }
    if (error.message === 'VARIABLE_KEY_TAKEN') {
      return res.status(409).json({ message: 'Переменная с таким ключом уже есть.' });
    }
    console.error(fallbackMessage, error);
    return res.status(500).json({ message: fallbackMessage });
  }

  router.get('/api/ai/prompt-variables', requireRight(db, 'settings_read'), (_req, res) => {
    try {
      return res.json({ variables: listPromptVariables(db) });
    } catch (error) {
      console.error('List AI prompt variables error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить переменные.' });
    }
  });

  router.post('/api/ai/prompt-variables/test', requireRight(db, 'prompt_variables_create'), express.json(), (req, res) => {
    try {
      const source = req.body?.source != null ? String(req.body.source) : '';
      return res.json(testVariableSource(db, source, req.body?.context || {}));
    } catch (error) {
      return respondPromptVariableWriteError(res, error, 'Не удалось выполнить переменную.');
    }
  });

  router.post('/api/ai/prompt-variables/:id/test', requireRight(db, 'prompt_variables_create'), express.json(), (req, res) => {
    try {
      const variable = getPromptVariable(db, req.params.id);
      const source = req.body?.source != null ? String(req.body.source) : variable.source;
      return res.json(testVariableSource(db, source, req.body?.context || {}));
    } catch (error) {
      return respondPromptVariableWriteError(res, error, 'Не удалось выполнить переменную.');
    }
  });

  router.post('/api/ai/prompt-variables', requireRight(db, 'prompt_variables_create'), express.json(), (req, res) => {
    try {
      const variable = createPromptVariable(
        db,
        { key: req.body?.key, name: req.body?.name, source: req.body?.source },
        { updatedBy: resolveKnowledgeActorUserId(req) }
      );
      auditAdminChange(db, req, {
        entityType: 'ai_prompt_variable',
        entityId: variable.id,
        action: 'create',
        summary: `Создана переменная промпта «${variable.key}»`,
        details: buildAuditDetails({ before: null, after: variable }),
      });
      return res.status(201).json({ variable });
    } catch (error) {
      return respondPromptVariableWriteError(res, error, 'Не удалось создать переменную.');
    }
  });

  router.put('/api/ai/prompt-variables/:id', requireRight(db, 'prompt_variables_create'), express.json(), (req, res) => {
    try {
      const before = getPromptVariable(db, req.params.id);
      const variable = updatePromptVariable(
        db,
        req.params.id,
        { key: req.body?.key, name: req.body?.name, source: req.body?.source },
        { updatedBy: resolveKnowledgeActorUserId(req) }
      );
      auditAdminChange(db, req, {
        entityType: 'ai_prompt_variable',
        entityId: variable.id,
        action: 'update',
        summary: `Изменена переменная промпта «${variable.key}»`,
        details: buildAuditDetails({ before, after: variable }),
      });
      return res.json({ variable });
    } catch (error) {
      return respondPromptVariableWriteError(res, error, 'Не удалось сохранить переменную.');
    }
  });

  router.delete('/api/ai/prompt-variables/:id', requireRight(db, 'prompt_variables_create'), (req, res) => {
    try {
      const before = getPromptVariable(db, req.params.id);
      const result = deletePromptVariable(db, req.params.id);
      auditAdminChange(db, req, {
        entityType: 'ai_prompt_variable',
        entityId: before.id,
        action: 'delete',
        summary: `Удалена переменная промпта «${before.key}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true, variable: result.variable });
    } catch (error) {
      return respondPromptVariableWriteError(res, error, 'Не удалось удалить переменную.');
    }
  });

  function resolveKnowledgeActorUserId(req) {
    const actor = getSessionActor(req);
    if (actor?.type === 'user') return Number(actor.userId) || null;
    if (actor?.type === 'telegram') {
      const user = getBotUserByTelegramId(db, actor.telegramId);
      return user?.id ?? null;
    }
    return null;
  }

  function knowledgeArticleLockMessage() {
    return 'Статья заблокирована. Изменение и удаление недоступны.';
  }

  function parseCategoryIdFilter(value) {
    if (value == null || value === '') return undefined;
    const raw = String(value).trim().toLowerCase();
    if (raw === 'none' || raw === 'uncategorized' || raw === '0') return null;
    const id = Number(value);
    if (!Number.isFinite(id) || id <= 0) return undefined;
    return id;
  }

  function articleFieldsFromBody(body = {}) {
    const input = {
      title: body.title,
      body: body.body,
      tags: body.tags,
    };
    if (Object.prototype.hasOwnProperty.call(body, 'category_id')) {
      input.category_id = body.category_id;
    }
    return input;
  }

  function respondKnowledgeWriteError(res, error, fallbackMessage) {
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({ message: 'Статья не найдена.' });
    }
    if (error.message === 'ARTICLE_LOCKED') {
      return res.status(409).json({ message: knowledgeArticleLockMessage() });
    }
    if (
      [
        'INVALID_ARTICLE_TITLE',
        'INVALID_ARTICLE_BODY',
        'INVALID_ARTICLE_TAGS',
        'INVALID_ARTICLE_CATEGORY',
      ].includes(error.message)
    ) {
      return res.status(400).json({
        message:
          error.message === 'INVALID_ARTICLE_CATEGORY'
            ? 'Некорректная категория статьи.'
            : 'Некорректные данные статьи.',
      });
    }
    console.error(fallbackMessage, error);
    return res.status(500).json({ message: fallbackMessage });
  }

  function respondKnowledgeCategoryWriteError(res, error, fallbackMessage) {
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({ message: 'Категория не найдена.' });
    }
    if (['INVALID_CATEGORY_NAME', 'INVALID_CATEGORY_TAGS'].includes(error.message)) {
      return res.status(400).json({ message: 'Некорректные данные категории.' });
    }
    console.error(fallbackMessage, error);
    return res.status(500).json({ message: fallbackMessage });
  }

  router.get('/api/knowledge/categories', requireRight(db, 'knowledge_read'), (_req, res) => {
    try {
      return res.json({ categories: listKnowledgeCategories(db) });
    } catch (error) {
      console.error('List knowledge categories error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить категории.' });
    }
  });

  router.post('/api/knowledge/categories', requireRight(db, 'knowledge_edit'), express.json(), (req, res) => {
    try {
      const category = createKnowledgeCategory(db, { name: req.body?.name, tags: req.body?.tags });
      auditAdminChange(db, req, {
        entityType: 'knowledge_category',
        entityId: category.id,
        action: 'create',
        summary: `Создана категория «${category.name}»`,
        details: buildAuditDetails({ before: null, after: category }),
      });
      return res.status(201).json({ category });
    } catch (error) {
      return respondKnowledgeCategoryWriteError(res, error, 'Не удалось создать категорию.');
    }
  });

  router.put('/api/knowledge/categories/:id', requireRight(db, 'knowledge_edit'), express.json(), (req, res) => {
    try {
      const before = getKnowledgeCategory(db, req.params.id);
      const category = updateKnowledgeCategory(db, req.params.id, {
        name: req.body?.name,
        tags: req.body?.tags,
      });
      auditAdminChange(db, req, {
        entityType: 'knowledge_category',
        entityId: category.id,
        action: 'update',
        summary: `Изменена категория #${category.id}`,
        details: buildAuditDetails({ before, after: category }),
      });
      return res.json({ category });
    } catch (error) {
      return respondKnowledgeCategoryWriteError(res, error, 'Не удалось обновить категорию.');
    }
  });

  router.delete('/api/knowledge/categories/:id', requireRight(db, 'knowledge_edit'), (req, res) => {
    try {
      const before = getKnowledgeCategory(db, req.params.id);
      const deleted = deleteKnowledgeCategory(db, req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Категория не найдена.' });
      auditAdminChange(db, req, {
        entityType: 'knowledge_category',
        entityId: before.id,
        action: 'delete',
        summary: `Удалена категория #${before.id}`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error) {
      return respondKnowledgeCategoryWriteError(res, error, 'Не удалось удалить категорию.');
    }
  });

  router.get('/api/knowledge/articles', requireRight(db, 'knowledge_read'), (req, res) => {
    try {
      const query = String(req.query.q || '').trim();
      const categoryId = parseCategoryIdFilter(req.query.category_id);
      let { page, limit, offset } = parsePaginationQuery(req);
      let result = listKnowledgeArticles(db, { query, offset, limit, categoryId });
      const totalPages = Math.max(1, Math.ceil(result.total / limit) || 1);
      if (page > totalPages) {
        page = totalPages;
        offset = (page - 1) * limit;
        result = listKnowledgeArticles(db, { query, offset, limit, categoryId });
      }
      return res.json({
        articles: result.articles,
        total: result.total,
        page,
        limit,
      });
    } catch (error) {
      console.error('List knowledge articles error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить базу знаний.' });
    }
  });

  router.get('/api/knowledge/articles/:id', requireRight(db, 'knowledge_read'), (req, res) => {
    const article = getKnowledgeArticle(db, req.params.id);
    if (!article) return res.status(404).json({ message: 'Статья не найдена.' });
    return res.json({ article });
  });

  router.post('/api/knowledge/articles', requireRight(db, 'knowledge_edit'), express.json(), (req, res) => {
    try {
      const article = createKnowledgeArticle(
        db,
        articleFieldsFromBody(req.body),
        { updatedBy: resolveKnowledgeActorUserId(req) }
      );
      auditAdminChange(db, req, {
        entityType: 'knowledge_article',
        entityId: article.id,
        action: 'create',
        summary: `Создана статья «${article.title}»`,
        details: buildAuditDetails({ before: null, after: article }),
      });
      return res.status(201).json({ article });
    } catch (error) {
      if (
        [
          'INVALID_ARTICLE_TITLE',
          'INVALID_ARTICLE_BODY',
          'INVALID_ARTICLE_TAGS',
          'INVALID_ARTICLE_CATEGORY',
        ].includes(error.message)
      ) {
        return res.status(400).json({
          message:
            error.message === 'INVALID_ARTICLE_CATEGORY'
              ? 'Некорректная категория статьи.'
              : 'Некорректные данные статьи.',
        });
      }
      console.error('Create knowledge article error:', error);
      return res.status(500).json({ message: 'Не удалось создать статью.' });
    }
  });

  router.put('/api/knowledge/articles/:id', requireRight(db, 'knowledge_edit'), express.json(), (req, res) => {
    try {
      const before = getKnowledgeArticle(db, req.params.id);
      const article = updateKnowledgeArticle(
        db,
        req.params.id,
        articleFieldsFromBody(req.body),
        { updatedBy: resolveKnowledgeActorUserId(req) }
      );
      auditAdminChange(db, req, {
        entityType: 'knowledge_article',
        entityId: article.id,
        action: 'update',
        summary: `Изменена статья #${article.id}`,
        details: buildAuditDetails({ before, after: article }),
      });
      return res.json({ article });
    } catch (error) {
      return respondKnowledgeWriteError(res, error, 'Не удалось обновить статью.');
    }
  });

  router.post('/api/knowledge/articles/:id/lock', requireRight(db, 'knowledge_lock'), (req, res) => {
    try {
      const before = getKnowledgeArticle(db, req.params.id);
      const article = setKnowledgeArticleLocked(db, req.params.id, true, {
        updatedBy: resolveKnowledgeActorUserId(req),
      });
      auditAdminChange(db, req, {
        entityType: 'knowledge_article',
        entityId: article.id,
        action: 'lock',
        summary: `Заблокирована статья #${article.id}`,
        details: buildAuditDetails({ before, after: article }),
      });
      return res.json({ article });
    } catch (error) {
      return respondKnowledgeWriteError(res, error, 'Не удалось заблокировать статью.');
    }
  });

  router.post('/api/knowledge/articles/:id/unlock', requireRight(db, 'knowledge_unlock'), (req, res) => {
    try {
      const before = getKnowledgeArticle(db, req.params.id);
      const article = setKnowledgeArticleLocked(db, req.params.id, false, {
        updatedBy: resolveKnowledgeActorUserId(req),
      });
      auditAdminChange(db, req, {
        entityType: 'knowledge_article',
        entityId: article.id,
        action: 'unlock',
        summary: `Разблокирована статья #${article.id}`,
        details: buildAuditDetails({ before, after: article }),
      });
      return res.json({ article });
    } catch (error) {
      return respondKnowledgeWriteError(res, error, 'Не удалось разблокировать статью.');
    }
  });

  router.delete('/api/knowledge/articles/:id', requireRight(db, 'knowledge_edit'), (req, res) => {
    try {
      const before = getKnowledgeArticle(db, req.params.id);
      const deleted = deleteKnowledgeArticle(db, req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Статья не найдена.' });
      auditAdminChange(db, req, {
        entityType: 'knowledge_article',
        entityId: before.id,
        action: 'delete',
        summary: `Удалена статья #${before.id}`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error) {
      return respondKnowledgeWriteError(res, error, 'Не удалось удалить статью.');
    }
  });

  router.get('/api/ai/kb-session', requireRight(db, 'knowledge_read'), (req, res) => {
    try {
      const session = getOrCreateKbSession(db, { userId: resolveKnowledgeActorUserId(req) });
      return res.json({
        session_id: session.id,
        messages: listKbSessionMessages(db, session.id),
      });
    } catch (error) {
      console.error('Load KB session error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить чат базы знаний.' });
    }
  });

  router.post('/api/ai/kb-session', requireRight(db, 'knowledge_edit'), express.json(), (req, res) => {
    try {
      const userId = resolveKnowledgeActorUserId(req);
      const session = Boolean(req.body?.reset)
        ? clearKbSessionHistory(db, { sessionId: req.body?.session_id, userId })
        : getOrCreateKbSession(db, { sessionId: req.body?.session_id, userId });
      return res.json({
        session_id: session.id,
        messages: listKbSessionMessages(db, session.id),
      });
    } catch (error) {
      if (error.message === 'FORBIDDEN') {
        return res.status(403).json({ message: 'Нет доступа к этому чату.' });
      }
      console.error('Update KB session error:', error);
      return res.status(500).json({ message: 'Не удалось обновить чат базы знаний.' });
    }
  });

  router.post(
    '/api/ai/kb-chat',
    requireRight(db, 'knowledge_edit'),
    express.json({ limit: CHAT_MESSAGE_JSON_LIMIT }),
    async (req, res) => {
    try {
      let files;
      try {
        files = parseChatUploadFiles(req.body?.files);
      } catch (parseError) {
        return res.status(parseError.status || 400).json({
          message: parseError.message || 'Некорректный файл.',
        });
      }
      const message = String(req.body?.message || '').trim();
      if (!message && files.length === 0) {
        return res.status(400).json({ message: 'Введите текст сообщения или прикрепите файл.' });
      }
      const result = await runKbAgent({
        db,
        userId: resolveKnowledgeActorUserId(req),
        sessionId: req.body?.session_id,
        message,
        files,
        canWrite: actorHasPermission(db, getSessionActor(req), 'knowledge_edit'),
      });
      return res.json(result);
    } catch (error) {
      if (error.message === 'EMPTY_MESSAGE') {
        return res.status(400).json({ message: 'Введите текст сообщения или прикрепите файл.' });
      }
      if (isAiCredentialError(error)) {
        return res.status(503).json({ message: aiCredentialErrorMessage(error) });
      }
      console.error('KB chat error:', error);
      return res.status(500).json({ message: 'Не удалось получить ответ агента.' });
    }
  });

  function parseOptionalTestTicketId(value) {
    if (value === undefined) return undefined;
    if (value == null || value === '') return null;
    const id = Number(value);
    return Number.isFinite(id) && id > 0 ? id : null;
  }

  function parseOptionalTestPhone(value) {
    if (value === undefined) return undefined;
    return String(value || '').trim();
  }

  function sendCustomerTestError(res, error) {
    if (error.message === 'EMPTY_MESSAGE') {
      return res.status(400).json({ message: 'Введите текст сообщения или прикрепите файл.' });
    }
    if (error.message === 'TICKET_NOT_FOUND') {
      return res.status(404).json({ message: 'Тикет не найден.' });
    }
    if (error.message === 'SESSION_NOT_FOUND') {
      return res.status(404).json({ message: 'Сессия не найдена.' });
    }
    if (error.message === 'SESSION_FORBIDDEN') {
      return res.status(403).json({ message: 'Нет доступа к этой тестовой сессии.' });
    }
    if (error.message === 'SESSION_BUSY') {
      return res.status(409).json({ message: 'Агент ещё отвечает. Подождите.' });
    }
    if (error instanceof RegosCrmError) {
      return res.status(error.status).json({ message: error.message });
    }
    if (isAiCredentialError(error)) {
      return res.status(503).json({ message: aiCredentialErrorMessage(error) });
    }
    console.error('Customer test agent error:', error);
    return res.status(500).json({ message: 'Не удалось получить ответ агента поддержки.' });
  }

  function canSeeAllTestHistory(req) {
    return actorHasPermission(db, getSessionActor(req), 'ai_customer_test_history');
  }

  function parseAllUsersFlag(value) {
    const raw = String(value ?? '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
  }

  router.get('/api/ai/test-sessions', requireRight(db, 'ai_customer_test'), (req, res) => {
    try {
      const allowAnyUser = canSeeAllTestHistory(req);
      const allUsers = parseAllUsersFlag(req.query.all);
      const sessions = listCustomerTestSessions(db, {
        userId: resolveKnowledgeActorUserId(req),
        agentKind: req.query.agent_kind,
        allUsers,
        allowAnyUser,
      });
      return res.json({ sessions, all_users: Boolean(allUsers && allowAnyUser) });
    } catch (error) {
      return sendCustomerTestError(res, error);
    }
  });

  router.delete('/api/ai/test-sessions/:id', requireRight(db, 'ai_customer_test'), (req, res) => {
    try {
      const deleted = deleteCustomerTestSession(db, req.params.id, {
        userId: resolveKnowledgeActorUserId(req),
        allowAnyUser: canSeeAllTestHistory(req),
      });
      if (!deleted) {
        return res.status(404).json({ message: 'Сессия не найдена.' });
      }
      return res.json({ ok: true });
    } catch (error) {
      return sendCustomerTestError(res, error);
    }
  });

  router.post('/api/ai/test-sessions/clear', requireRight(db, 'ai_customer_test'), express.json(), (req, res) => {
    try {
      const allowAnyUser = canSeeAllTestHistory(req);
      const allUsers = parseAllUsersFlag(req.body?.all ?? req.query.all);
      const result = clearCustomerTestSessions(db, {
        userId: resolveKnowledgeActorUserId(req),
        agentKind: req.body?.agent_kind ?? req.query.agent_kind,
        allUsers,
        allowAnyUser,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return sendCustomerTestError(res, error);
    }
  });

  router.get('/api/ai/customer-test-session', requireRight(db, 'ai_customer_test'), async (req, res) => {
    try {
      const result = await loadCustomerTestSession({
        db,
        userId: resolveKnowledgeActorUserId(req),
        sessionId: req.query.session_id,
        requireTicket: false,
        allowAnyUser: canSeeAllTestHistory(req),
      });
      return res.json(result);
    } catch (error) {
      return sendCustomerTestError(res, error);
    }
  });

  router.post('/api/ai/customer-test-session', requireRight(db, 'ai_customer_test'), express.json(), async (req, res) => {
    try {
      const result = await loadCustomerTestSession({
        db,
        userId: resolveKnowledgeActorUserId(req),
        sessionId: req.body?.session_id,
        ticketId: parseOptionalTestTicketId(req.body?.ticket_id),
        clientPhone: parseOptionalTestPhone(req.body?.client_phone),
        reset: Boolean(req.body?.reset),
        allowAnyUser: canSeeAllTestHistory(req),
      });
      return res.json(result);
    } catch (error) {
      return sendCustomerTestError(res, error);
    }
  });

  router.post(
    '/api/ai/customer-test-chat',
    requireRight(db, 'ai_customer_test'),
    express.json({ limit: CHAT_MESSAGE_JSON_LIMIT }),
    async (req, res) => {
    try {
      let files;
      try {
        files = parseChatUploadFiles(req.body?.files);
      } catch (parseError) {
        return res.status(parseError.status || 400).json({
          message: parseError.message || 'Некорректный файл.',
        });
      }
      const message = String(req.body?.message || '').trim();
      if (!message && files.length === 0) {
        return res.status(400).json({ message: 'Введите текст сообщения или прикрепите файл.' });
      }
      const result = await runCustomerTestAgent({
        db,
        userId: resolveKnowledgeActorUserId(req),
        sessionId: req.body?.session_id,
        message,
        files,
        ticketId: parseOptionalTestTicketId(req.body?.ticket_id),
        clientPhone: parseOptionalTestPhone(req.body?.client_phone),
        allowAnyUser: canSeeAllTestHistory(req),
      });
      return res.json(result);
    } catch (error) {
      return sendCustomerTestError(res, error);
    }
  });

  router.get('/api/ai/employee-test-session', requireRight(db, 'ai_customer_test'), async (req, res) => {
    try {
      const result = await loadEmployeeTestSession({
        db,
        userId: resolveKnowledgeActorUserId(req),
        sessionId: req.query.session_id,
        requireTicket: false,
        allowAnyUser: canSeeAllTestHistory(req),
      });
      return res.json(result);
    } catch (error) {
      return sendCustomerTestError(res, error);
    }
  });

  router.post('/api/ai/employee-test-session', requireRight(db, 'ai_customer_test'), express.json(), async (req, res) => {
    try {
      const result = await loadEmployeeTestSession({
        db,
        userId: resolveKnowledgeActorUserId(req),
        sessionId: req.body?.session_id,
        ticketId: parseOptionalTestTicketId(req.body?.ticket_id),
        clientPhone: parseOptionalTestPhone(req.body?.client_phone),
        reset: Boolean(req.body?.reset),
        allowAnyUser: canSeeAllTestHistory(req),
      });
      return res.json(result);
    } catch (error) {
      return sendCustomerTestError(res, error);
    }
  });

  router.post(
    '/api/ai/employee-test-chat',
    requireRight(db, 'ai_customer_test'),
    express.json({ limit: CHAT_MESSAGE_JSON_LIMIT }),
    async (req, res) => {
      try {
        let files;
        try {
          files = parseChatUploadFiles(req.body?.files);
        } catch (parseError) {
          return res.status(parseError.status || 400).json({
            message: parseError.message || 'Некорректный файл.',
          });
        }
        const message = String(req.body?.message || '').trim();
        if (!message && files.length === 0) {
          return res.status(400).json({ message: 'Введите текст сообщения или прикрепите файл.' });
        }
        const result = await runEmployeeTestAgent({
          db,
          userId: resolveKnowledgeActorUserId(req),
          sessionId: req.body?.session_id,
          message,
          files,
          ticketId: parseOptionalTestTicketId(req.body?.ticket_id),
          clientPhone: parseOptionalTestPhone(req.body?.client_phone),
          allowAnyUser: canSeeAllTestHistory(req),
        });
        return res.json(result);
      } catch (error) {
        return sendCustomerTestError(res, error);
      }
    }
  );

  router.get('/api/tickets/:id', requireRight(db, 'tickets_read'), async (req, res) => {
    try {
      const ticket = await findTicketById(req.params.id);
      if (!ticket) {
        return res.status(404).json({ message: 'Тикет не найден.' });
      }
      const recordingUrl = cacheTicketRecordingUrl(ticket);
      if (recordingUrl) {
        upsertTicketRecording(db, {
          ticketId: ticket.id,
          recordingUrl: recordingUrl.href,
        });
      }
      const [enriched] = enrichTicketsWithLocalData(db, [ticket]);
      return res.json({ ticket: enriched || ticket });
    } catch (error) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status).json({ message: error.message });
      }
      console.error('Get ticket error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить тикет.' });
    }
  });

  router.put(
    '/api/tickets/:id/ai-state',
    requireRight(db, 'tickets_edit'),
    express.json(),
    async (req, res) => {
      try {
        const ticket = await findTicketById(req.params.id);
        if (!ticket) {
          return res.status(404).json({ message: 'Тикет не найден.' });
        }
        const raw =
          req.body?.ai_stopped ?? req.body?.aiStopped ?? req.body?.stopped;
        if (raw == null) {
          return res.status(400).json({ message: 'Укажите ai_stopped.' });
        }
        const stopped =
          raw === true ||
          raw === 1 ||
          raw === '1' ||
          String(raw).trim().toLowerCase() === 'true';
        const before = isTicketAiStopped(db, ticket.id);
        const state = setTicketAiStopped(db, ticket.id, stopped);
        auditAdminChange(db, req, {
          entityType: 'ticket_ai_state',
          entityId: ticket.id,
          action: stopped ? 'stop' : 'resume',
          summary: stopped
            ? `Остановлены автоответы клиенту для тикета #${ticket.id}`
            : `Возобновлены автоответы клиенту для тикета #${ticket.id}`,
          details: buildAuditDetails({
            before: { ai_stopped: before },
            after: { ai_stopped: Boolean(state?.ai_stopped) },
          }),
        });
        return res.json({
          ok: true,
          ticket_id: ticket.id,
          ai_stopped: Boolean(state?.ai_stopped),
          updated_at: state?.updated_at || null,
        });
      } catch (error) {
        if (error?.code === 'INVALID_TICKET_ID') {
          return res.status(400).json({ message: 'Некорректный ID тикета.' });
        }
        if (error instanceof RegosCrmError) {
          return res.status(error.status).json({ message: error.message });
        }
        console.error('Update ticket AI state error:', error);
        return res.status(500).json({ message: 'Не удалось обновить состояние ИИ тикета.' });
      }
    }
  );

  router.get('/api/tickets/:id/ai-prompt', requireRight(db, 'tickets_ai_prompt'), async (req, res) => {
    try {
      const rawMessageId = req.query.message_id != null ? String(req.query.message_id).trim() : '';
      const preview = await previewCustomerAgentPrompt({
        db,
        ticketId: req.params.id,
        messageId: rawMessageId || undefined,
      });
      return res.json(preview);
    } catch (error) {
      if (error?.code === 'ticket-not-found') {
        return res.status(404).json({ message: 'Тикет не найден.' });
      }
      if (error instanceof RegosCrmError) {
        return res.status(error.status).json({ message: error.message });
      }
      console.error('Get ticket AI prompt error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить промпт ИИ.' });
    }
  });

  async function resolveSummaryTicketContext(ticketId) {
    try {
      return await findTicketById(ticketId);
    } catch (error) {
      if (error instanceof RegosCrmError && error.status === 404) return null;
      console.warn('[bot-admin] Failed to load ticket for summary:', error.message || error);
      return null;
    }
  }

  router.put(
    '/api/tickets/:id/summary',
    requireRight(db, 'tickets_ai_prompt'),
    express.json(),
    async (req, res) => {
      try {
        const existing = getTicketSummary(db, req.params.id);
        const bodyClientId = req.body?.client_id ?? req.body?.clientId;
        const bodyChatId = req.body?.chat_id ?? req.body?.chatId;
        const ticket =
          existing || bodyClientId != null || bodyChatId != null
            ? null
            : await resolveSummaryTicketContext(req.params.id);
        const summary = saveTicketSummaryText(db, req.params.id, req.body?.summary, {
          clientId: bodyClientId ?? (ticket ? resolveTicketClientId(ticket) : undefined),
          chatId: bodyChatId ?? ticket?.chat_id,
        });
        auditAdminChange(db, req, {
          entityType: 'ticket_summary',
          entityId: summary.ticket_id,
          action: existing ? 'update' : 'create',
          summary: existing
            ? `Изменена сводка обращения #${summary.ticket_id}`
            : `Создана сводка обращения #${summary.ticket_id}`,
          details: buildAuditDetails({ before: existing, after: summary }),
        });
        return res.json({ summary });
      } catch (error) {
        if (error.message === 'INVALID_TICKET_ID') {
          return res.status(400).json({ message: 'Некорректный идентификатор тикета.' });
        }
        if (error.message === 'INVALID_SUMMARY') {
          return res.status(400).json({ message: 'Введите текст сводки.' });
        }
        console.error('Save ticket summary error:', error);
        return res.status(500).json({ message: 'Не удалось сохранить сводку обращения.' });
      }
    }
  );

  router.delete('/api/tickets/:id/summary', requireRight(db, 'tickets_ai_prompt'), (req, res) => {
    try {
      const before = deleteTicketSummary(db, req.params.id);
      if (!before) {
        return res.status(404).json({ message: 'Сводка обращения не найдена.' });
      }
      auditAdminChange(db, req, {
        entityType: 'ticket_summary',
        entityId: before.ticket_id,
        action: 'delete',
        summary: `Удалена сводка обращения #${before.ticket_id}`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error) {
      if (error.message === 'INVALID_TICKET_ID') {
        return res.status(400).json({ message: 'Некорректный идентификатор тикета.' });
      }
      console.error('Delete ticket summary error:', error);
      return res.status(500).json({ message: 'Не удалось удалить сводку обращения.' });
    }
  });

  function sendTicketAssistError(res, error) {
    if (error.message === 'EMPTY_MESSAGE') {
      return res.status(400).json({ message: 'Введите текст сообщения или прикрепите файл.' });
    }
    if (error.message === 'TICKET_NOT_FOUND' || error.message === 'INVALID_TICKET_ID') {
      return res.status(404).json({ message: 'Тикет не найден.' });
    }
    if (error.message === 'SESSION_BUSY') {
      return res.status(409).json({ message: 'Агент ещё отвечает. Подождите.' });
    }
    if (error instanceof RegosCrmError) {
      return res.status(error.status).json({ message: error.message });
    }
    if (isAiCredentialError(error)) {
      return res.status(503).json({ message: aiCredentialErrorMessage(error) });
    }
    console.error('Ticket AI assist error:', error);
    return res.status(500).json({ message: 'Не удалось получить ответ агента поддержки.' });
  }

  router.get('/api/tickets/:id/ai-assist', requireRight(db, 'tickets_read'), async (req, res) => {
    try {
      const result = await loadTicketAssistSession({
        db,
        userId: resolveKnowledgeActorUserId(req),
        ticketId: req.params.id,
        sessionId: req.query.session_id,
      });
      return res.json(result);
    } catch (error) {
      return sendTicketAssistError(res, error);
    }
  });

  router.post('/api/tickets/:id/ai-assist', requireRight(db, 'tickets_read'), express.json(), async (req, res) => {
    try {
      const result = await loadTicketAssistSession({
        db,
        userId: resolveKnowledgeActorUserId(req),
        ticketId: req.params.id,
        sessionId: req.body?.session_id,
        reset: Boolean(req.body?.reset),
      });
      return res.json(result);
    } catch (error) {
      return sendTicketAssistError(res, error);
    }
  });

  router.post(
    '/api/tickets/:id/ai-assist-chat',
    requireRight(db, 'tickets_read'),
    express.json({ limit: CHAT_MESSAGE_JSON_LIMIT }),
    async (req, res) => {
      try {
        let files;
        try {
          files = parseChatUploadFiles(req.body?.files);
        } catch (parseError) {
          return res.status(parseError.status || 400).json({
            message: parseError.message || 'Некорректный файл.',
          });
        }
        const message = String(req.body?.message || '').trim();
        if (!message && files.length === 0) {
          return res.status(400).json({ message: 'Введите текст сообщения или прикрепите файл.' });
        }
        const result = await runTicketAssistAgent({
          db,
          userId: resolveKnowledgeActorUserId(req),
          ticketId: req.params.id,
          sessionId: req.body?.session_id,
          message,
          files,
        });
        return res.json(result);
      } catch (error) {
        return sendTicketAssistError(res, error);
      }
    }
  );

  router.get('/api/tickets/:id/recording', requireRight(db, 'tickets_read'), async (req, res) => {
    const abortController = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    try {
      let recordingUrl = resolveRecordingUrlFromStore(req.params.id);
      if (!recordingUrl) {
        const ticket = await findTicketById(req.params.id);
        if (!ticket) {
          return res.status(404).json({ message: 'Тикет не найден.' });
        }
        recordingUrl = cacheTicketRecordingUrl(ticket);
        if (recordingUrl) {
          upsertTicketRecording(db, {
            ticketId: ticket.id,
            recordingUrl: recordingUrl.href,
          });
        }
      }
      if (!recordingUrl) {
        return res.status(404).json({ message: 'Запись звонка не найдена.' });
      }

      const range = String(req.headers.range || '').trim();
      const upstream = await fetchUpstreamMedia(recordingUrl, {
        range,
        signal: abortController.signal,
      });

      if (![200, 206].includes(upstream.status) || !upstream.body) {
        console.error(
          `[bot-admin] Recording server returned ${upstream.status} for ticket ${req.params.id}`
        );
        return res.status(502).json({ message: 'Не удалось загрузить запись звонка.' });
      }

      res.status(upstream.status);
      for (const header of [
        'accept-ranges',
        'content-length',
        'content-range',
        'content-type',
        'etag',
        'last-modified',
      ]) {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Disposition', 'inline');
      await pipeline(Readable.fromWeb(upstream.body), res);
      return undefined;
    } catch (error) {
      if (abortController.signal.aborted) return undefined;
      console.error('Get ticket recording error:', error);
      if (res.headersSent) {
        res.destroy(error);
        return undefined;
      }
      if (error instanceof RegosCrmError) {
        return res.status(error.status).json({ message: error.message });
      }
      return res.status(502).json({ message: 'Не удалось загрузить запись звонка.' });
    }
  });

  router.get('/api/tickets/:id/messages', requireRight(db, 'tickets_read'), async (req, res) => {
    try {
      const ticket = await findTicketById(req.params.id);
      if (!ticket) {
        return res.status(404).json({ message: 'Тикет не найден.' });
      }

      const chatId = ticket.chat_id ? String(ticket.chat_id).trim() : '';
      if (!chatId) {
        return res.json({
          chat_id: null,
          messages: [],
          next_offset: 0,
          total: 0,
          offset: 0,
          has_older: false,
        });
      }

      const limit = Math.min(
        100,
        Math.max(1, Number(req.query.limit) || DEFAULT_CHAT_MESSAGE_LIMIT)
      );
      // ChatMessage/Get is newest-first: offset 0 is the latest page.
      // from_end is accepted for compatibility and maps to that latest page.
      const offset = Math.max(0, Number(req.query.offset) || 0);

      const page = await getTicketMessages(chatId, {
        limit,
        offset,
        includeStaffPrivate: true,
      });

      let filesById = new Map();
      try {
        filesById = await resolveChatFiles(chatId, collectMessageFileIds(page.result));
      } catch (fileError) {
        console.error('Get ticket chat files error:', fileError);
      }

      let userNames = {};
      try {
        userNames = await buildRegosUserNameMap();
      } catch (userError) {
        console.error('Get ticket chat user names error:', userError);
      }

      const messages = enrichChatMessages(attachPublicFiles(page.result, filesById), {
        ticketId: ticket.id,
        userNames,
      });
      const total = Number(page.total) || messages.length;
      const nextOffset = page.next_offset ?? page.offset + messages.length;

      return res.json({
        chat_id: chatId,
        messages,
        next_offset: nextOffset,
        total,
        offset: page.offset,
        has_older: nextOffset < total,
      });
    } catch (error) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status).json({ message: error.message });
      }
      console.error('Get ticket messages error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить сообщения чата.' });
    }
  });

  router.post(
    '/api/tickets/:id/messages',
    requireRight(db, 'tickets_read'),
    express.json({ limit: CHAT_MESSAGE_JSON_LIMIT }),
    async (req, res) => {
      try {
        const ticket = await findTicketById(req.params.id);
        if (!ticket) {
          return res.status(404).json({ message: 'Тикет не найден.' });
        }

        const chatId = ticket.chat_id ? String(ticket.chat_id).trim() : '';
        if (!chatId) {
          return res.status(400).json({ message: 'Чат не привязан к этому тикету.' });
        }

        let files;
        try {
          files = parseChatUploadFiles(req.body?.files);
        } catch (parseError) {
          return res.status(parseError.status || 400).json({
            message: parseError.message || 'Некорректный файл.',
          });
        }

        const text = String(req.body?.text || '').trim();
        if (!text && files.length === 0) {
          return res.status(400).json({ message: 'Введите текст сообщения или прикрепите файл.' });
        }

        const regosUserId = resolveSessionRegosUserId(db, req);
        if (!regosUserId) {
          return res.status(400).json({
            message:
              'Чтобы отвечать в чате тикета, привяжите аккаунт REGOS к сотруднику ' +
              '(Пользователи → связь с REGOS). Вход через общий логин без привязки не подходит.',
          });
        }

        if (!isTicketStaffParticipant(ticket, regosUserId)) {
          try {
            await ensureTicketParticipant(ticket.id, regosUserId);
          } catch (participantError) {
            if (participantError instanceof RegosCrmError) {
              return res.status(participantError.status).json({
                message:
                  'Вы не участник этого тикета в REGOS, и не удалось добавить вас автоматически. ' +
                  'Назначьте себя участником/ответственным в regos.online или выдайте интеграции ' +
                  `право crm_ticket_participant_manage (745). ${participantError.message}`,
              });
            }
            throw participantError;
          }
        }

        const currentResponsibleId = Number(ticket.responsible_user_id);
        if (!Number.isInteger(currentResponsibleId) || currentResponsibleId <= 0) {
          await setTicketResponsible(ticket.id, regosUserId);
        }

        const fileIds = [];
        for (const file of files) {
          const uploaded = await addChatFile({
            chatId,
            name: file.name,
            extension: file.extension,
            data: file.data,
            width: file.width,
            height: file.height,
          });
          if (uploaded.file_id) {
            fileIds.push(uploaded.file_id);
          }
        }

        const created = await addTicketMessage({
          chatId,
          text,
          fileIds,
          authorEntityId: regosUserId,
          authorEntityType: 'User',
        });
        auditAdminChange(db, req, {
          entityType: 'ticket',
          entityId: ticket.id,
          action: 'send_message',
          summary: `Сообщение в тикет #${ticket.id}`,
          details: buildAuditDetails({
            before: null,
            after: {
              chat_id: chatId,
              message_id: created.id,
              text_preview: text.slice(0, 120),
              file_ids: fileIds,
            },
          }),
        });
        const payload = {
          id: created.id,
          chat_id: chatId,
          author_entity_id: regosUserId,
        };
        if (fileIds.length) {
          payload.file_ids = fileIds;
        }
        ticketEventHub.publish({
          type: 'chat_changed',
          chat_id: chatId,
          message_id: created.id != null ? String(created.id) : null,
          source_action: 'ChatMessageAdded',
          occurred_at: new Date().toISOString(),
        });
        return res.status(201).json(payload);
      } catch (error) {
        if (error instanceof RegosCrmError) {
          return res.status(error.status).json({ message: error.message });
        }
        console.error('Send ticket message error:', error);
        return res.status(500).json({ message: 'Не удалось отправить сообщение.' });
      }
    }
  );

  router.get('/api/tickets/:id/files/:fileId', requireRight(db, 'tickets_read'), async (req, res) => {
    const abortController = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    try {
      const ticket = await findTicketById(req.params.id);
      if (!ticket) {
        return res.status(404).json({ message: 'Тикет не найден.' });
      }
      const chatId = ticket.chat_id ? String(ticket.chat_id).trim() : '';
      if (!chatId) {
        return res.status(404).json({ message: 'Чат не привязан к этому тикету.' });
      }

      const fileId = Number(req.params.fileId);
      if (!Number.isFinite(fileId) || fileId <= 0) {
        return res.status(400).json({ message: 'Некорректный файл.' });
      }

      let file = getCachedChatFile(fileId);
      if (!file) {
        const filesById = await resolveChatFiles(chatId, [fileId]);
        file = filesById.get(fileId) || null;
      }
      if (!file) {
        return res.status(404).json({ message: 'Файл не найден.' });
      }
      if (!isSafeFileUrl(file.url)) {
        return res.status(502).json({ message: 'Не удалось загрузить файл.' });
      }

      const range = String(req.headers.range || '').trim();
      const upstream = await fetchUpstreamMedia(file.url, {
        range,
        signal: abortController.signal,
      });
      if (![200, 206].includes(upstream.status) || !upstream.body) {
        console.error(
          `[bot-admin] Chat file server returned ${upstream.status} for ticket ${req.params.id} file ${fileId}`
        );
        return res.status(502).json({ message: 'Не удалось загрузить файл.' });
      }

      res.status(upstream.status);
      const contentType = resolveChatFileContentType(file, upstream.headers.get('content-type'));
      res.setHeader('Content-Type', contentType);
      for (const header of ['accept-ranges', 'content-length', 'content-range', 'etag', 'last-modified']) {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      const filename = file.name || `file-${fileId}${file.extension ? `.${file.extension}` : ''}`;
      res.setHeader(
        'Content-Disposition',
        `inline; filename*=UTF-8''${encodeURIComponent(filename)}`
      );
      res.setHeader('Cache-Control', 'private, max-age=300');
      await pipeline(Readable.fromWeb(upstream.body), res);
      return undefined;
    } catch (error) {
      if (abortController.signal.aborted) return undefined;
      console.error('Get ticket chat file error:', error);
      if (res.headersSent) {
        res.destroy(error);
        return undefined;
      }
      if (error instanceof RegosCrmError) {
        return res.status(error.status).json({ message: error.message });
      }
      return res.status(502).json({ message: 'Не удалось загрузить файл.' });
    }
  });

  router.get(
    '/api/firm-search',
    requireAnyRight(db, ['tickets_read', 'clients_link_firm']),
    async (req, res) => {
      const q = String(req.query.q || '').trim();
      if (!q) {
        return res.status(400).json({ message: 'Укажите поисковый запрос.' });
      }
      try {
        const result = await searchFirmAdmin(q, db);
        if (result.error) {
          return res.status(502).json({ message: result.message || 'Не удалось выполнить поиск.' });
        }
        if (!result.found) {
          return res.json({ found: false, results: [] });
        }
        const results = (result.results || []).map((entry) => ({
          type: entry.type || null,
          phone: entry.phone || null,
          recordId: entry.recordId ?? null,
          clientName: entry.clientName || null,
          message: entry.message || null,
        }));
        return res.json({ found: results.length > 0, results });
      } catch (error) {
        console.error('Firm search error:', error);
        return res.status(500).json({ message: 'Не удалось выполнить поиск.' });
      }
    }
  );

  router.get('/api/firms/:type/:recordId', requireRight(db, 'tickets_read'), async (req, res) => {
    try {
      const firm = await getFirmCardByTypeAndId(db, req.params.type, req.params.recordId);
      if (!firm) {
        return res.status(404).json({ message: 'Фирма не найдена.' });
      }
      return res.json({
        firm: {
          type: firm.type || null,
          recordId: firm.recordId ?? null,
          clientName: firm.clientName || null,
          phone: firm.phone || null,
          message: firm.message || null,
        },
      });
    } catch (error) {
      console.error('Get firm card error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить фирму.' });
    }
  });

  router.get('/api/orders', requireRight(db, 'orders_read'), (req, res) => {
    const query = String(req.query.q || '').trim();
    const clientPhone = String(req.query.client || req.query.client_phone || '').trim();
    const status = String(req.query.status || '').trim();
    const paymentProvider = String(req.query.payment || req.query.payment_provider || '').trim();
    const fromDate = String(req.query.from_date || '').trim();
    const toDate = String(req.query.to_date || '').trim();
    const telegramIdRaw = String(req.query.telegram_id || req.query.employee || '').trim();
    const telegramId = telegramIdRaw ? Number(telegramIdRaw) : undefined;
    let { page, limit, offset } = parsePaginationQuery(req);
    const options = {
      query: query || undefined,
      clientPhone: clientPhone || undefined,
      status: status || undefined,
      paymentProvider: paymentProvider || undefined,
      from: fromDate || undefined,
      to: toDate || undefined,
      telegramId: Number.isFinite(telegramId) && telegramId !== 0 ? telegramId : undefined,
      offset,
      limit,
    };
    let result = listOrders(db, options);
    const totalPages = Math.max(1, Math.ceil(result.total / limit) || 1);
    if (page > totalPages) {
      page = totalPages;
      options.offset = (page - 1) * limit;
      result = listOrders(db, options);
    }
    res.json({
      orders: result.orders.map((order) => mapAdminOrderRow(enrichOrderParties(db, order))),
      total: result.total,
      page,
      limit,
      summary: result.summary,
    });
  });

  router.get('/api/orders/employees', requireRight(db, 'orders_read'), (_req, res) => {
    const employees = listEmployeeUsers(db)
      .filter((user) => user.telegram_id != null)
      .map((user) => {
        const displayName =
          String(user.display_name || '').trim() ||
          [user.first_name, user.last_name].filter(Boolean).join(' ').trim() ||
          (user.username ? `@${String(user.username).replace(/^@/, '')}` : '') ||
          null;
        return {
          telegram_id: user.telegram_id,
          display_name: displayName,
          phone: user.phone || null,
        };
      })
      .sort((a, b) =>
        String(a.display_name || a.phone || a.telegram_id).localeCompare(
          String(b.display_name || b.phone || b.telegram_id),
          'ru'
        )
      );
    res.json({ employees });
  });

  router.post('/api/orders/:id/delete', requireRight(db, 'delete_unpaid_order'), (req, res) => {
    const orderId = String(req.params.id || '').trim();
    if (!orderId) {
      return res.status(400).json({ message: 'Не указан ID заказа.' });
    }
    const existing = getOrderById(db, orderId);
    const deleted = deletePendingOrder(db, orderId, resolveActorTelegramId(db, req));
    if (!deleted) {
      return res.status(409).json({
        message: 'Не удалось удалить заказ. Возможно, он уже оплачен или удалён.',
      });
    }
    auditAdminChange(db, req, {
      entityType: 'order',
      entityId: orderId,
      action: 'delete_unpaid',
      summary: `Удалён неоплаченный заказ ${orderId}`,
      details: buildAuditDetails({
        before: snapshotOrderForAudit(existing),
        after: null,
      }),
    });
    return res.json({ ok: true, message: 'Неоплаченный заказ удалён.' });
  });

  router.post('/api/orders/:id/delete-cash', requireRight(db, 'delete_cash_order'), (req, res) => {
    const orderId = String(req.params.id || '').trim();
    if (!orderId) {
      return res.status(400).json({ message: 'Не указан ID заказа.' });
    }
    const existing = getOrderById(db, orderId);
    const deleted = deletePaidCashOrder(db, orderId, resolveActorTelegramId(db, req));
    if (!deleted) {
      return res.status(409).json({
        message: 'Не удалось удалить заказ. Возможно, он не оплачен наличными или уже удалён.',
      });
    }
    auditAdminChange(db, req, {
      entityType: 'order',
      entityId: orderId,
      action: 'delete_cash',
      summary: `Удалён заказ „Наличные“ ${orderId}`,
      details: buildAuditDetails({
        before: snapshotOrderForAudit(existing),
        after: null,
      }),
    });
    return res.json({ ok: true, message: 'Заказ „Наличные“ удалён.' });
  });

  router.post('/api/orders/:id/paid-cash', requireRight(db, 'mark_paid_cash'), (req, res) => {
    const orderId = String(req.params.id || '').trim();
    if (!orderId) {
      return res.status(400).json({ message: 'Не указан ID заказа.' });
    }
    const existing = getOrderById(db, orderId);
    const closed = markPendingOrderPaidCash(db, orderId, resolveActorTelegramId(db, req));
    if (!closed) {
      return res.status(409).json({
        message: 'Не удалось закрыть заказ. Возможно, он уже оплачен или удалён.',
      });
    }
    const updated = getOrderById(db, orderId);
    auditAdminChange(db, req, {
      entityType: 'order',
      entityId: orderId,
      action: 'paid_cash',
      summary: `Заказ ${orderId} отмечен как оплаченный наличными`,
      details: buildAuditDetails({
        before: snapshotOrderForAudit(existing),
        after: snapshotOrderForAudit(updated || { ...existing, status: 'paid', payment_provider: 'cash' }),
      }),
    });
    return res.json({ ok: true, message: 'Заказ закрыт: оплачено наличными.' });
  });

  router.post(
    '/api/orders/:id/renotify',
    requireRight(db, 'renotify_order'),
    async (req, res) => {
      const orderId = String(req.params.id || '').trim();
      if (!orderId) {
        return res.status(400).json({ message: 'Не указан ID заказа.' });
      }
      const order = getOrderById(db, orderId);
      if (!order || order.status !== 'pending') {
        return res.status(409).json({
          message: 'Не удалось уведомить. Заказ не найден или уже оплачен.',
        });
      }
      try {
        const paymentPageUrl = formatPaymentPageUrl(order.id);
        const result = await enqueueOrderPaymentSms(db, order, paymentPageUrl);
        auditAdminChange(db, req, {
          entityType: 'order',
          entityId: orderId,
          action: 'renotify',
          summary: `Повторное уведомление по заказу ${orderId}`,
          details: buildAuditDetails({
            before: snapshotOrderForAudit(order),
            after: snapshotOrderForAudit(order),
            changes: null,
            result,
          }),
        });
        return res.json({
          ok: true,
          message: formatRenotifyResultMessage(result),
          result,
        });
      } catch (error) {
        console.error('Renotify order error:', error);
        return res.status(500).json({ message: 'Не удалось отправить уведомление.' });
      }
    }
  );

  router.post('/api/orders', requireRight(db, 'tickets_read'), express.json(), async (req, res) => {
    try {
      const botUser = resolveSessionBotUser(db, req);
      if (!botUser || botUser.telegram_id == null) {
        return res.status(403).json({
          message:
            'Создавать заказы можно только под учётной записью сотрудника с Telegram. Войдите через /open_dashboard или логин сотрудника.',
        });
      }

      const amount = parsePositiveAmount(req.body?.amount);
      if (!amount) {
        return res.status(400).json({ message: 'Укажите положительную сумму (целое число).' });
      }

      const clientPhoneRaw = String(req.body?.client_phone || '').trim();
      if (!clientPhoneRaw || !looksLikePhone(clientPhoneRaw)) {
        return res.status(400).json({ message: 'Укажите корректный телефон клиента.' });
      }
      const clientPhone = normalizePhone(clientPhoneRaw);

      let additionalPhone = null;
      const additionalRaw = String(req.body?.additional_phone || '').trim();
      if (additionalRaw) {
        if (!looksLikePhone(additionalRaw)) {
          return res.status(400).json({ message: 'Неверный дополнительный номер телефона.' });
        }
        additionalPhone = normalizePhone(additionalRaw);
      }

      const ticketIdRaw = req.body?.ticket_id;
      const ticketId =
        ticketIdRaw == null || ticketIdRaw === '' ? null : Number(ticketIdRaw);
      if (ticketIdRaw != null && ticketIdRaw !== '' && !Number.isFinite(ticketId)) {
        return res.status(400).json({ message: 'Некорректный ticket_id.' });
      }

      const clientName = req.body?.client_name != null ? String(req.body.client_name).trim() : '';
      const clientType = req.body?.client_type != null ? String(req.body.client_type).trim() : '';
      const firmMessage =
        req.body?.firm_message != null ? String(req.body.firm_message).trim() : '';
      const firmPhoneRaw =
        req.body?.firm_phone != null ? String(req.body.firm_phone).trim() : '';
      const recordIdRaw = req.body?.record_id;
      const recordId =
        recordIdRaw == null || recordIdRaw === '' ? null : recordIdRaw;
      const hasFirm = Boolean(clientType || recordId != null || firmMessage);

      const clientIdRaw = req.body?.client_id;
      const clientId =
        clientIdRaw == null || clientIdRaw === '' ? null : Number(clientIdRaw);
      if (clientIdRaw != null && clientIdRaw !== '' && (!Number.isInteger(clientId) || clientId <= 0)) {
        return res.status(400).json({ message: 'Некорректный client_id.' });
      }

      const metadata = JSON.stringify({
        type: clientType || null,
        message: hasFirm
          ? firmMessage || null
          : ticketId != null
            ? `Заказ из тикета #${ticketId}`
            : null,
        recordId: recordId,
        clientName: clientName || null,
        source: 'bot-admin-tickets',
      });

      const id = crypto.randomUUID();
      const order = createOrder(db, {
        id,
        telegramId: botUser.telegram_id,
        botUserPhone: botUser.phone,
        clientPhone,
        clientType: clientType || null,
        additionalPhone,
        amount,
        paymentProvider: getDefaultPaymentProvider(),
        metadata,
        ticketId,
      });
      const detailedOrder = enrichOrderParties(db, order);
      const paymentUrl = formatClickUrlSafe(detailedOrder.id, detailedOrder.amount);
      const paymentPageUrl = formatPaymentPageUrl(order.id);

      let firmLink = { linked: false, reason: 'skipped' };
      const actor = getSessionActor(req);
      const canLinkFirm = actorHasPermission(db, actor, 'clients_link_firm');
      const firmType = clientType || null;
      const firmRecordId = recordId;
      if (!canLinkFirm) {
        firmLink = { linked: false, reason: 'no_permission' };
      } else if (clientId == null) {
        firmLink = { linked: false, reason: 'no_client_id' };
      } else if (!firmType || firmRecordId == null || firmRecordId === '') {
        firmLink = { linked: false, reason: 'no_firm' };
      } else {
        try {
          const link = addClientFirmLink(db, {
            regos_client_id: clientId,
            type: firmType,
            recordId: firmRecordId,
            clientName: clientName || null,
            phone: firmPhoneRaw || clientPhone,
            message: firmMessage || null,
          });
          firmLink = { linked: true, id: link?.id ?? null };
        } catch (err) {
          if (err?.code === 'DUPLICATE_LINK') {
            firmLink = { linked: true, reason: 'already_linked' };
          } else {
            console.warn('[bot-admin] Auto firm link failed:', err.message);
            firmLink = { linked: false, reason: 'error', message: err.message };
          }
        }
      }

      const outboundBot = getOutboundBot();
      if (outboundBot) {
        try {
          await outboundBot.sendMessage(
            botUser.telegram_id,
            formatOrderPaymentMessage(detailedOrder, paymentPageUrl, paymentUrl),
            withHtml()
          );
        } catch (err) {
          console.warn('[bot-admin] Creator notify failed:', err.message);
        }
        try {
          await afterOrderCreated(outboundBot, db, botUser, detailedOrder, paymentPageUrl);
        } catch (err) {
          console.error('[bot-admin] Post-create notify failed:', err.message);
        }
      } else {
        try {
          await afterOrderCreated(null, db, botUser, detailedOrder, paymentPageUrl);
        } catch (err) {
          console.error('[bot-admin] Post-create SMS failed:', err.message);
        }
      }

      auditAdminChange(db, req, {
        entityType: 'order',
        entityId: order.id,
        action: 'create',
        summary: `Создан заказ ${order.id} на ${amount} сум`,
        details: buildAuditDetails({
          before: null,
          after: {
            ...snapshotOrderForAudit(detailedOrder),
            ticket_id: ticketId,
            firm_link: firmLink,
          },
        }),
      });

      return res.status(201).json({
        order: detailedOrder,
        payment_page_url: paymentPageUrl,
        firm_link: firmLink,
      });
    } catch (error) {
      console.error('Create order error:', error);
      return res.status(500).json({ message: 'Не удалось создать заказ.' });
    }
  });

  router.get('/api/tickets', requireRight(db, 'tickets_read'), async (req, res) => {
    try {
      let { page, limit } = parsePaginationQuery(req);
      const q = String(req.query.q || '').trim();
      const status = String(req.query.status || '').trim();
      const fromDate = String(req.query.from_date || '').trim();
      const toDate = String(req.query.to_date || '').trim();
      const responsibleUserId = String(req.query.responsible_user_id || '').trim();
      const channelId = String(req.query.channel_id || '').trim();
      const minimumCallDurationRaw = String(req.query.minimum_call_duration_seconds || '').trim();
      const durationFilterActive = minimumCallDurationRaw !== '';
      const minimumCallDuration = Number(minimumCallDurationRaw);
      if (
        durationFilterActive &&
        (!Number.isFinite(minimumCallDuration) || minimumCallDuration < 0)
      ) {
        return res.status(400).json({ message: 'Минимальная длительность должна быть неотрицательной.' });
      }
      const withoutDuplicates =
        req.query.without_duplicates === '1' || req.query.without_duplicates === 'true';
      let duplicateIntervalMinutes = Number(req.query.duplicate_interval_minutes);
      if (!Number.isFinite(duplicateIntervalMinutes) || duplicateIntervalMinutes < 0) {
        duplicateIntervalMinutes = DEFAULT_DUPLICATE_INTERVAL_MINUTES;
      }

      const filters = buildTicketFilters({
        status: status || undefined,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
        responsibleUserId: responsibleUserId || undefined,
        channelId: channelId || undefined,
      });

      // Active ticket is always for the session REGOS user, not the list filter.
      const activeForUserId = resolveSessionRegosUserId(db, req) || null;

      const ticketsPromise = fetchAllTickets({
        search: q || undefined,
        filters: filters.length ? filters : undefined,
        sort_orders: [{ column: 'last_update', direction: 'DESC' }],
      });
      const activeTicketPromise = activeForUserId
        ? findLatestTicketForResponsibleUser(activeForUserId).then((latest) =>
            mapEnrichedActiveTicket(db, latest)
          )
        : Promise.resolve(null);

      let [tickets, activeTicket] = await Promise.all([ticketsPromise, activeTicketPromise]);

      if (withoutDuplicates) {
        tickets = dedupeTickets(tickets, duplicateIntervalMinutes);
      }

      const durationSummary = durationFilterActive
        ? buildDurationSummary(tickets, listRegosChannelSettings(db), db)
        : null;
      if (durationSummary) {
        tickets.forEach(cacheTicketRecordingUrl);
      }
      // When the duration filter is active, totals use SQL-known call durations
      // immediately (message channels stay in the base). The browser may refine
      // further once it probes recordings that are not cached yet.
      const summary = durationSummary
        ? summarizeByDuration(
            durationSummary,
            buildDurationsByTicketId(durationSummary),
            minimumCallDuration
          )
        : summarizeTickets(tickets);
      const total = tickets.length;
      const totalPages = Math.max(1, Math.ceil(total / limit) || 1);
      if (page > totalPages) {
        page = totalPages;
      }
      const safeOffset = (page - 1) * limit;
      const pageTickets = enrichTicketsWithLocalData(
        db,
        tickets.slice(safeOffset, safeOffset + limit)
      );
      // Keep list responses fast: sync missing URLs only, never download audio here.
      await resolveMissingTicketRecordings(db, pageTickets, { fetchDuration: false });
      for (const ticket of pageTickets) {
        const href = ticket?.local?.recording?.url;
        if (href) {
          seedRecordingUrlCache(recordingUrlCache, ticket.id, href);
        } else {
          cacheTicketRecordingUrl(ticket);
        }
      }
      // Warm duration cache after the response path; cooldown skips repeated failures.
      scheduleTicketRecordingDurationBackfill(db, pageTickets);

      return res.json({
        tickets: pageTickets,
        total,
        page,
        limit,
        summary,
        duration_summary: durationSummary,
        active_ticket: activeTicket,
        active_ticket_user_id: activeForUserId ? Number(activeForUserId) : null,
      });
    } catch (error) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status).json({ message: error.message });
      }
      console.error('List tickets error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить тикеты.' });
    }
  });

  router.get('/api/technical-support/prices', requireRight(db, 'technical_support_read'), (_req, res) => {
    res.json({ prices: listTechnicalSupportPrices(db) });
  });

  router.put(
    '/api/technical-support/prices',
    requireRight(db, 'technical_support_edit'),
    express.json(),
    (req, res) => {
    try {
      const beforePrices = snapshotPricesForAudit(listTechnicalSupportPrices(db));
      const prices = updateTechnicalSupportPrices(db, req.body?.prices || req.body || {});
      const afterPrices = snapshotPricesForAudit(prices);
      auditAdminChange(db, req, {
        entityType: 'technical_support_price',
        entityId: null,
        action: 'update',
        summary: 'Обновлены цены технической поддержки',
        details: buildAuditDetails({
          before: Object.fromEntries(
            (beforePrices || []).map((row) => [String(row.months), row.amount])
          ),
          after: Object.fromEntries(
            (afterPrices || []).map((row) => [String(row.months), row.amount])
          ),
        }),
      });
      return res.json({ prices });
    } catch (error) {
      if (error.message === 'INVALID_AMOUNT') {
        return res.status(400).json({ message: 'Сумма должна быть целым числом ≥ 0.' });
      }
      if (error.message === 'NO_PRICES') {
        return res.status(400).json({ message: 'Укажите хотя бы одну цену для обновления.' });
      }
      console.error('Update technical support prices error:', error);
      return res.status(500).json({ message: 'Не удалось сохранить цены.' });
    }
  });

  router.get(
    '/api/technical-support/subscriptions',
    requireRight(db, 'technical_support_read'),
    (req, res) => {
    const query = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    let { page, limit, offset } = parsePaginationQuery(req);
    let result = listTechnicalSupportSubscriptions(db, {
      query,
      status,
      offset,
      limit,
    });
    const totalPages = Math.max(1, Math.ceil(result.total / limit) || 1);
    if (page > totalPages) {
      page = totalPages;
      offset = (page - 1) * limit;
      result = listTechnicalSupportSubscriptions(db, {
        query,
        status,
        offset,
        limit,
      });
    }
    res.json({
      subscriptions: result.items,
      total: result.total,
      page,
      limit,
    });
  });

  router.post(
    '/api/technical-support/subscriptions',
    requireRight(db, 'technical_support_create'),
    express.json(),
    (req, res) => {
      try {
        const result = createManualTechnicalSupportSubscription(db, {
          phone: req.body?.phone,
          months: req.body?.months,
          amount: req.body?.amount,
          ends_at: req.body?.ends_at,
        });
        auditAdminChange(db, req, {
          entityType: 'technical_support_subscription',
          entityId: result.subscription?.id,
          action: 'create',
          summary: `Создана подписка ТП для ${result.subscription?.phone || req.body?.phone}`,
          details: buildAuditDetails({
            before: null,
            after: mapSubscriptionRow(result.subscription),
          }),
        });
        return res.status(201).json({
          subscription: mapSubscriptionRow(result.subscription),
        });
      } catch (error) {
        if (error.message === 'INVALID_PHONE') {
          return res.status(400).json({ message: 'Укажите корректный телефон.' });
        }
        if (error.message === 'INVALID_MONTHS') {
          return res.status(400).json({ message: 'Срок должен быть 1, 3, 6 или 12 месяцев.' });
        }
        if (error.message === 'INVALID_AMOUNT') {
          return res.status(400).json({ message: 'Сумма должна быть целым числом ≥ 0.' });
        }
        if (error.message === 'INVALID_ENDS_AT') {
          return res
            .status(400)
            .json({ message: 'Укажите корректную дату окончания в будущем.' });
        }
        console.error('Create technical support subscription error:', error);
        return res.status(500).json({ message: 'Не удалось создать подписку.' });
      }
    }
  );

  router.post(
    '/api/technical-support/subscriptions/:id/deactivate',
    requireRight(db, 'technical_support_edit'),
    (req, res) => {
      try {
        const before = getTechnicalSupportSubscriptionById(db, req.params.id);
        const result = deactivateTechnicalSupportSubscription(db, req.params.id);
        auditAdminChange(db, req, {
          entityType: 'technical_support_subscription',
          entityId: req.params.id,
          action: 'deactivate',
          summary: `Деактивирована подписка ТП #${req.params.id}`,
          details: buildAuditDetails({
            before: before ? mapSubscriptionRow(before) : null,
            after: mapSubscriptionRow(result.subscription),
          }),
        });
        return res.json({
          changed: result.changed,
          reason: result.reason || null,
          subscription: mapSubscriptionRow(result.subscription),
        });
      } catch (error) {
        if (error.message === 'NOT_FOUND') {
          return res.status(404).json({ message: 'Подписка не найдена.' });
        }
        console.error('Deactivate technical support subscription error:', error);
        return res.status(500).json({ message: 'Не удалось деактивировать подписку.' });
      }
    }
  );

  router.put(
    '/api/technical-support/subscriptions/:id',
    requireRight(db, 'technical_support_edit'),
    express.json(),
    (req, res) => {
      try {
        const before = getTechnicalSupportSubscriptionById(db, req.params.id);
        const result = updateTechnicalSupportSubscriptionEndsAt(db, req.params.id, req.body?.ends_at);
        auditAdminChange(db, req, {
          entityType: 'technical_support_subscription',
          entityId: req.params.id,
          action: 'update',
          summary: `Обновлена дата окончания подписки ТП #${req.params.id}`,
          details: buildAuditDetails({
            before: before
              ? {
                  ends_at: mapSubscriptionRow(before).ends_at ?? null,
                  phone: before.phone ?? null,
                }
              : null,
            after: {
              ends_at: result.subscription?.ends_at ?? null,
              phone: result.subscription?.phone ?? before?.phone ?? null,
            },
          }),
        });
        return res.json({
          subscription: mapSubscriptionRow(result.subscription),
        });
      } catch (error) {
        if (error.message === 'NOT_FOUND') {
          return res.status(404).json({ message: 'Подписка не найдена.' });
        }
        if (error.message === 'INVALID_ENDS_AT') {
          return res.status(400).json({ message: 'Укажите корректную дату окончания.' });
        }
        console.error('Update technical support subscription error:', error);
        return res.status(500).json({ message: 'Не удалось обновить подписку.' });
      }
    }
  );

  router.delete(
    '/api/technical-support/subscriptions/:id',
    requireRight(db, 'technical_support_delete'),
    (req, res) => {
      try {
        const before = getTechnicalSupportSubscriptionById(db, req.params.id);
        const result = deleteTechnicalSupportSubscription(db, req.params.id);
        auditAdminChange(db, req, {
          entityType: 'technical_support_subscription',
          entityId: req.params.id,
          action: 'delete',
          summary: `Удалена подписка ТП #${req.params.id}`,
          details: buildAuditDetails({
            before: before ? mapSubscriptionRow(before) : null,
            after: null,
          }),
        });
        return res.json({ deleted: result.deleted, id: result.id });
      } catch (error) {
        if (error.message === 'NOT_FOUND') {
          return res.status(404).json({ message: 'Подписка не найдена.' });
        }
        console.error('Delete technical support subscription error:', error);
        return res.status(500).json({ message: 'Не удалось удалить подписку.' });
      }
    }
  );

  router.get('/api/prices', requireRight(db, 'prices_read'), (_req, res) => {
    try {
      return res.json(getServicePricesCatalog(db));
    } catch (error) {
      console.error('Load service prices error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить прайс.' });
    }
  });

  router.put(
    '/api/prices',
    requireAnyRight(db, ['prices_edit', 'prices_create', 'prices_delete']),
    express.json({ limit: '1mb' }),
    (req, res) => {
    try {
      const beforeCatalog = snapshotCatalogForAudit(getServicePricesCatalog(db));
      const catalog = replaceServicePricesCatalog(db, req.body || {});
      const afterCatalog = snapshotCatalogForAudit(catalog);
      auditAdminChange(db, req, {
        entityType: 'service_price',
        entityId: null,
        action: 'update',
        summary: `Обновлён прайс (${catalog?.categories?.length ?? 0} кат.)`,
        details: buildAuditDetails({
          before: beforeCatalog,
          after: afterCatalog,
        }),
      });
      return res.json(catalog);
    } catch (error) {
      const messages = {
        INVALID_TEXT: 'Проверьте обязательные текстовые поля и их длину.',
        INVALID_PRICE: 'Значение цены слишком длинное.',
        NO_CATEGORIES: 'Добавьте хотя бы одну категорию.',
        NO_ITEMS: 'В каждой категории должна быть хотя бы одна услуга.',
        TOO_MANY_CATEGORIES: 'Слишком много категорий.',
        TOO_MANY_ITEMS: 'Слишком много услуг в категории.',
      };
      if (messages[error.message]) {
        return res.status(400).json({ message: messages[error.message] });
      }
      console.error('Update service prices error:', error);
      return res.status(500).json({ message: 'Не удалось сохранить прайс.' });
    }
  });

  router.get('/api/regos-users', requireRight(db, 'users_read'), async (_req, res) => {
    try {
      const users = await fetchAllUsers({ activeOnly: true });
      return res.json({
        users: users.map(mapRegosUserSummary),
      });
    } catch (error) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status).json({ message: error.message });
      }
      console.error('List REGOS users error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить пользователей REGOS.' });
    }
  });

  router.post('/api/users', requireRight(db, 'users_create'), express.json(), async (req, res) => {
    try {
      const phone = String(req.body?.phone || '').trim();
      if (!phone) {
        return res.status(400).json({ message: 'Укажите номер телефона.' });
      }
      let user = createEmployeeUser(db, {
        phone,
        displayName: req.body?.display_name,
        jobTitle: req.body?.job_title,
        description: req.body?.description,
        rights: parseRightsBody(req.body?.rights || req.body),
        adminLogin: parseOptionalCredential(req.body?.admin_login),
        password: parseOptionalCredential(req.body?.password),
      });

      const hasExplicitRegos = Object.prototype.hasOwnProperty.call(req.body || {}, 'regos_user_id');
      user = await applyRegosLinkToUser(db, user.id, {
        regosUserId: hasExplicitRegos ? req.body.regos_user_id : undefined,
        autoLink: !hasExplicitRegos || req.body?.auto_link_regos !== false,
      });

      auditAdminChange(db, req, {
        entityType: 'user',
        entityId: user.id,
        action: 'create',
        summary: `Создан сотрудник ${user.phone || user.id}`,
        details: buildAuditDetails({
          before: null,
          after: snapshotUserForAudit(user),
        }),
      });

      return res.status(201).json({ user: mapUserResponse(user) });
    } catch (error) {
      const mapped = mapRegosLinkError(error);
      if (mapped) {
        return res.status(mapped.status).json({ message: mapped.message });
      }
      if (error.message === 'PHONE_EXISTS') {
        return res.status(409).json({ message: 'Пользователь с таким телефоном уже существует.' });
      }
      if (error.message === 'LOGIN_EXISTS') {
        return res.status(409).json({ message: 'Этот логин уже занят другим сотрудником.' });
      }
      if (error.message === 'PASSWORD_REQUIRED') {
        return res.status(400).json({ message: 'Укажите пароль для входа в админ-панель.' });
      }
      if (error.message === 'LOGIN_REQUIRED') {
        return res.status(400).json({ message: 'Укажите логин для входа в админ-панель.' });
      }
      console.error('Create employee error:', error);
      return res.status(500).json({ message: 'Не удалось создать пользователя.' });
    }
  });

  router.put('/api/users/:id', requireRight(db, 'users_edit'), express.json(), async (req, res) => {
    try {
      const userId = Number(req.params.id);
      const beforeUser =
        getEmployeeWithRights(db, userId) || getBotUserById(db, userId);
      const updates = {
        phone: req.body?.phone,
        displayName: req.body?.display_name,
        jobTitle: req.body?.job_title,
        description: req.body?.description,
        rights: req.body?.rights ? parseRightsBody(req.body.rights) : parseRightsBody(req.body),
      };
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'admin_login')) {
        updates.adminLogin = parseOptionalCredential(req.body.admin_login);
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'password')) {
        updates.password = parseOptionalCredential(req.body.password);
      }
      let user = updateEmployeeUser(db, userId, updates);

      const hasExplicitRegos = Object.prototype.hasOwnProperty.call(req.body || {}, 'regos_user_id');
      if (hasExplicitRegos || req.body?.auto_link_regos) {
        user = await applyRegosLinkToUser(db, userId, {
          regosUserId: hasExplicitRegos ? req.body.regos_user_id : undefined,
          autoLink: Boolean(req.body?.auto_link_regos) || !hasExplicitRegos,
        });
      }

      const before = snapshotUserForAudit(beforeUser);
      const after = snapshotUserForAudit(user);
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'password')) {
        before.password = beforeUser?.password_hash ? '[задано]' : null;
        after.password = '[изменено]';
      }
      auditAdminChange(db, req, {
        entityType: 'user',
        entityId: userId,
        action: 'update',
        summary: `Изменён сотрудник #${userId}`,
        details: buildAuditDetails({ before, after }),
      });

      return res.json({ user: mapUserResponse(user) });
    } catch (error) {
      const mapped = mapRegosLinkError(error);
      if (mapped) {
        return res.status(mapped.status).json({ message: mapped.message });
      }
      if (error.message === 'NOT_FOUND') {
        return res.status(404).json({ message: 'Пользователь не найден.' });
      }
      if (error.message === 'PHONE_EXISTS') {
        return res.status(409).json({ message: 'Пользователь с таким телефоном уже существует.' });
      }
      if (error.message === 'LOGIN_EXISTS') {
        return res.status(409).json({ message: 'Этот логин уже занят другим сотрудником.' });
      }
      if (error.message === 'PASSWORD_REQUIRED') {
        return res.status(400).json({ message: 'Укажите пароль для входа в админ-панель.' });
      }
      if (error.message === 'LOGIN_REQUIRED') {
        return res.status(400).json({ message: 'Укажите логин для входа в админ-панель.' });
      }
      console.error('Update employee error:', error);
      return res.status(500).json({ message: 'Не удалось обновить пользователя.' });
    }
  });

  router.post('/api/users/:id/promote', requireRight(db, 'users_edit'), express.json(), async (req, res) => {
    try {
      const userId = Number(req.params.id);
      const beforeUser = getBotUserById(db, userId);
      let user = convertCustomerToEmployee(db, userId, {
        displayName: req.body?.display_name,
        jobTitle: req.body?.job_title,
        description: req.body?.description,
        rights: parseRightsBody(req.body?.rights || req.body),
        adminLogin: parseOptionalCredential(req.body?.admin_login),
        password: parseOptionalCredential(req.body?.password),
      });

      const hasExplicitRegos = Object.prototype.hasOwnProperty.call(req.body || {}, 'regos_user_id');
      user = await applyRegosLinkToUser(db, user.id, {
        regosUserId: hasExplicitRegos ? req.body.regos_user_id : undefined,
        autoLink: !hasExplicitRegos || req.body?.auto_link_regos !== false,
      });

      auditAdminChange(db, req, {
        entityType: 'user',
        entityId: user.id,
        action: 'promote',
        summary: `Клиент #${userId} назначен сотрудником`,
        details: buildAuditDetails({
          before: snapshotUserForAudit(beforeUser),
          after: snapshotUserForAudit(user),
        }),
      });

      return res.json({ user: mapUserResponse(user) });
    } catch (error) {
      const mapped = mapRegosLinkError(error);
      if (mapped) {
        return res.status(mapped.status).json({ message: mapped.message });
      }
      if (error.message === 'NOT_FOUND') {
        return res.status(404).json({ message: 'Пользователь не найден.' });
      }
      if (error.message === 'NOT_CUSTOMER') {
        return res.status(400).json({ message: 'Можно назначить сотрудником только клиента.' });
      }
      if (error.message === 'LOGIN_EXISTS') {
        return res.status(409).json({ message: 'Этот логин уже занят другим сотрудником.' });
      }
      if (error.message === 'PASSWORD_REQUIRED') {
        return res.status(400).json({ message: 'Укажите пароль для входа в админ-панель.' });
      }
      if (error.message === 'LOGIN_REQUIRED') {
        return res.status(400).json({ message: 'Укажите логин для входа в админ-панель.' });
      }
      console.error('Promote customer error:', error);
      return res.status(500).json({ message: 'Не удалось назначить сотрудником.' });
    }
  });

  router.post(
    '/api/users/:id/regos-link',
    requireRight(db, 'users_edit'),
    express.json(),
    async (req, res) => {
      try {
        const userId = Number(req.params.id);
        const botUser = getBotUserById(db, userId);
        if (!botUser || botUser.role !== 'employee') {
          return res.status(404).json({ message: 'Пользователь не найден.' });
        }

        const auto = req.body?.auto === true || req.body?.auto_link_regos === true;
        const hasExplicit = Object.prototype.hasOwnProperty.call(req.body || {}, 'regos_user_id');
        if (!auto && !hasExplicit) {
          return res.status(400).json({
            message: 'Укажите regos_user_id или auto: true для сопоставления по телефону.',
          });
        }

        if (auto && !hasExplicit) {
          const regosUsers = await fetchAllUsers({ activeOnly: true });
          const used = new Set(
            listEmployeeUsers(db)
              .filter((user) => user.id !== userId && user.regos_user_id != null)
              .map((user) => Number(user.regos_user_id))
          );
          const match = matchPhoneToRegosUser(botUser.phone, regosUsers, {
            excludeRegosIds: used,
          });
          if (match.status === 'none') {
            return res.status(404).json({
              message: 'По телефону сотрудника не найден пользователь REGOS.',
            });
          }
          if (match.status === 'ambiguous') {
            return res.status(409).json({
              message: 'Найдено несколько пользователей REGOS с этим телефоном. Выберите вручную.',
              candidates: match.candidates.map(mapRegosUserSummary),
            });
          }
          const linked = setBotUserRegosLink(db, userId, {
            regosUserId: match.user.id,
            regosLogin: match.user.login,
            regosFullName: mapRegosUserSummary(match.user).full_name,
          });
          auditAdminChange(db, req, {
            entityType: 'user',
            entityId: userId,
            action: 'link_regos',
            summary: `REGOS привязан к сотруднику #${userId} по телефону`,
            details: buildAuditDetails({
              before: {
                regos_user_id: botUser.regos_user_id ?? null,
                regos_login: botUser.regos_login || null,
              },
              after: {
                regos_user_id: match.user.id,
                regos_login: match.user.login || null,
              },
            }),
          });
          return res.json({ user: mapUserResponse(linked), match: 'phone' });
        }

        const linked = await applyRegosLinkToUser(db, userId, {
          regosUserId: req.body.regos_user_id,
        });
        auditAdminChange(db, req, {
          entityType: 'user',
          entityId: userId,
          action: 'link_regos',
          summary: `REGOS привязан к сотруднику #${userId}`,
          details: buildAuditDetails({
            before: {
              regos_user_id: botUser.regos_user_id ?? null,
              regos_login: botUser.regos_login || null,
            },
            after: {
              regos_user_id: linked?.regos_user_id ?? req.body.regos_user_id ?? null,
              regos_login: linked?.regos_login || null,
            },
          }),
        });
        return res.json({ user: mapUserResponse(linked), match: 'manual' });
      } catch (error) {
        const mapped = mapRegosLinkError(error);
        if (mapped) {
          return res.status(mapped.status).json({ message: mapped.message });
        }
        console.error('Link REGOS user error:', error);
        return res.status(500).json({ message: 'Не удалось привязать пользователя REGOS.' });
      }
    }
  );

  router.delete('/api/users/:id/regos-link', requireRight(db, 'users_edit'), (req, res) => {
    try {
      const userId = Number(req.params.id);
      const botUser = getBotUserById(db, userId);
      if (!botUser || botUser.role !== 'employee') {
        return res.status(404).json({ message: 'Пользователь не найден.' });
      }
      const user = clearBotUserRegosLink(db, userId);
      auditAdminChange(db, req, {
        entityType: 'user',
        entityId: userId,
        action: 'unlink_regos',
        summary: `REGOS отвязан от сотрудника #${userId}`,
        details: buildAuditDetails({
          before: {
            regos_user_id: botUser.regos_user_id ?? null,
            regos_login: botUser.regos_login || null,
            regos_full_name: botUser.regos_full_name || null,
          },
          after: {
            regos_user_id: null,
            regos_login: null,
            regos_full_name: null,
          },
        }),
      });
      return res.json({ user: mapUserResponse(user) });
    } catch (error) {
      if (error.message === 'NOT_FOUND') {
        return res.status(404).json({ message: 'Пользователь не найден.' });
      }
      console.error('Unlink REGOS user error:', error);
      return res.status(500).json({ message: 'Не удалось отвязать пользователя REGOS.' });
    }
  });

  router.post(
    '/api/users/regos-auto-link',
    requireRight(db, 'users_edit'),
    express.json(),
    async (req, res) => {
      try {
        const force = req.body?.force === true;
        const employees = listEmployeeUsers(db);
        const regosUsers = await fetchAllUsers({ activeOnly: true });
        const plan = planRegosLinksByPhone(employees, regosUsers, { force });

        const summary = {
          matched: 0,
          already_linked: 0,
          none: 0,
          ambiguous: 0,
        };
        const items = [];

        for (const item of plan) {
          summary[item.status] = (summary[item.status] || 0) + 1;
          if (item.status === 'matched') {
            const linked = setBotUserRegosLink(db, item.botUserId, {
              regosUserId: item.regosUser.id,
              regosLogin: item.regosUser.login,
              regosFullName: mapRegosUserSummary(item.regosUser).full_name,
            });
            items.push({
              bot_user_id: item.botUserId,
              status: 'matched',
              user: mapUserResponse(linked),
            });
          } else {
            items.push({
              bot_user_id: item.botUserId,
              status: item.status,
              candidates: (item.candidates || []).map(mapRegosUserSummary),
            });
          }
        }

        auditAdminChange(db, req, {
          entityType: 'user',
          entityId: null,
          action: 'auto_link_regos',
          summary: `Автопривязка REGOS: matched=${summary.matched || 0}`,
          details: { summary, force },
        });

        return res.json({ ok: true, summary, items });
      } catch (error) {
        if (error instanceof RegosCrmError) {
          return res.status(error.status).json({ message: error.message });
        }
        console.error('Auto-link REGOS users error:', error);
        return res.status(500).json({ message: 'Не удалось выполнить автосопоставление с REGOS.' });
      }
    }
  );

  router.delete('/api/users/:id', requireRight(db, 'users_delete'), (req, res) => {
    try {
      const userId = Number(req.params.id);
      const existing = getEmployeeWithRights(db, userId) || getBotUserById(db, userId);
      deleteEmployeeUser(db, userId);
      auditAdminChange(db, req, {
        entityType: 'user',
        entityId: userId,
        action: 'delete',
        summary: `Удалён сотрудник #${userId}${existing?.phone ? ` (${existing.phone})` : ''}`,
        details: buildAuditDetails({
          before: snapshotUserForAudit(existing),
          after: null,
        }),
      });
      return res.json({ ok: true });
    } catch (error) {
      if (error.message === 'NOT_FOUND') {
        return res.status(404).json({ message: 'Пользователь не найден.' });
      }
      if (error.message === 'HAS_ORDERS') {
        return res.status(409).json({ message: 'Нельзя удалить сотрудника с созданными заказами.' });
      }
      console.error('Delete employee error:', error);
      return res.status(500).json({ message: 'Не удалось удалить пользователя.' });
    }
  });

  if (reactUiReady) {
    // SPA client routes — auth/permissions are enforced by the React app and APIs.
    const spaPagePaths = [
      '/users',
      '/orders',
      '/order-logs',
      '/logs',
      '/tickets',
      '/tickets/:id',
      '/technical-support',
      '/prices',
      '/knowledge',
      '/customer-agent',
      '/test-agents',
      '/prompts',
      '/settings',
    ];
    for (const spaPath of spaPagePaths) {
      router.get(spaPath, (_req, res) => sendBotAdminReactUiIndex(res));
    }
  } else {
    router.get('/order-logs', requireRight(db, 'order_logs_read'), (_req, res) => {
      return sendPublicFile(res, publicDir, 'order-logs.html');
    });

    router.get('/logs', requireRight(db, 'logs_read'), (_req, res) => {
      return sendPublicFile(res, publicDir, 'logs.html');
    });

    router.get('/orders', requireRight(db, 'orders_read'), (_req, res) => {
      return sendPublicFile(res, publicDir, 'orders.html');
    });

    router.get('/tickets/:id', requireRight(db, 'tickets_read'), (_req, res) => {
      return sendPublicFile(res, publicDir, 'ticket-detail.html');
    });

    router.get('/tickets', requireRight(db, 'tickets_read'), (_req, res) => {
      return sendPublicFile(res, publicDir, 'tickets.html');
    });

    router.get('/technical-support', requireRight(db, 'technical_support_read'), (_req, res) => {
      return sendPublicFile(res, publicDir, 'technical-support.html');
    });

    router.get('/prices', requireRight(db, 'prices_read'), (_req, res) => {
      return sendPublicFile(res, publicDir, 'prices.html');
    });

    router.get('/settings', requireRight(db, 'settings_read'), (_req, res) => {
      return sendPublicFile(res, publicDir, 'settings.html');
    });
  }

  router.get('/', (req, res) => {
    // Without the trailing slash the browser resolves page-relative asset URLs
    // against the site root, so redirect to the canonical directory form.
    if (!req.originalUrl.split('?')[0].endsWith('/')) {
      const query = req.originalUrl.slice(req.originalUrl.indexOf('?') + 1);
      const suffix = req.originalUrl.includes('?') ? `?${query}` : '';
      return res.redirect(`${req.baseUrl}/${suffix}`);
    }
    if (!isAuthenticated(req)) {
      return res.redirect('/bot-admin/login');
    }
    if (reactUiReady) {
      return sendBotAdminReactUiIndex(res);
    }
    const actor = getSessionActor(req);
    const permissions = getSessionPermissions(db, actor);
    if (permissions.tickets_read) return res.redirect('/bot-admin/tickets');
    if (permissions.orders_read) return res.redirect('/bot-admin/orders');
    if (permissions.order_logs_read) return res.redirect('/bot-admin/order-logs');
    if (permissions.logs_read) return res.redirect('/bot-admin/logs');
    if (permissions.technical_support_read) return res.redirect('/bot-admin/technical-support');
    if (permissions.prices_read) return res.redirect('/bot-admin/prices');
    if (permissions.settings_read) return res.redirect('/bot-admin/settings');
    if (permissions.users_read) {
      return sendPublicFile(res, publicDir, 'index.html');
    }
    return res.status(403).send('Нет доступа. Недостаточно прав для этого раздела.');
  });

  if (reactUiReady && fs.existsSync(reactUiDistDir)) {
    router.use(express.static(reactUiDistDir, { index: false }));
    router.get('*', (req, res, next) => {
      if (!isBotAdminSpaPath(req.path)) return next();
      return sendBotAdminReactUiIndex(res);
    });
  } else {
    router.use(requireAdminAuth, express.static(publicDir, { index: false }));
  }

  return router;
}

module.exports = {
  createBotAdminRouter,
  buildDurationSummary,
};
