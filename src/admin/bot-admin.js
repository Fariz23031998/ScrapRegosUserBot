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
  getAdminCredentials,
  isAuthenticated,
  getSessionActor,
  getSessionPermissions,
  setSessionCookie,
  clearSessionCookie,
  requireAdminAuth,
  requireRight,
  requireAnyRight,
} = require('./bot-admin-auth');
const { consumeDashboardLoginToken } = require('./dashboard-login-tokens');
const { hasRight, isLinkedEmployee } = require('../db/user-rights');
const { getBotUserByTelegramId } = require('../db/bot-users-db');
const {
  listTechnicalSupportPrices,
  updateTechnicalSupportPrices,
  listTechnicalSupportSubscriptions,
} = require('../db/technical-support');
const {
  enrichTicketsWithLocalData,
  resolveMissingTicketRecordings,
} = require('./ticket-local-enrichment');
const {
  getTicketRecording,
  upsertTicketRecording,
} = require('../db/ticket-recordings');
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
  ensureTicketParticipant,
  isTicketStaffParticipant,
  DEFAULT_CHAT_MESSAGE_LIMIT,
} = require('../integrations/regos-crm');
const { botAdminPublicDir } = require('../paths');
const { sendVersionedHtmlFile } = require('../http/asset-cache');
const { createOrder, listOrders, getOrderById, deletePendingOrder, markPendingOrderPaidCash } = require('../db/partners-db');
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
const { formatPaymentPageUrl, getDefaultPaymentProvider } = require('../payments/payments-api');
const { formatClickUrlSafe } = require('../payments/click');
const { enqueueOrderPaymentSms } = require('../sms/sms-queue');
const { ticketEventHub } = require('./ticket-events');
const { getTicketRecordingUrl } = require('./ticket-recording');
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
  paid_cash: 'Наличные',
  deleted: 'Удалён',
};

function mapAdminOrderRow(order) {
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
    payment_provider: order.payment_provider ?? null,
    payment_provider_label: formatPaymentProviderLabel(order.payment_provider),
    ticket_id: order.ticket_id ?? null,
    created_at: order.created_at,
    paid_at: order.paid_at ?? null,
  };
}

function resolveActorTelegramId(db, req) {
  const botUser = resolveSessionBotUser(db, req);
  return botUser?.telegram_id != null ? botUser.telegram_id : null;
}

function mapEnrichedActiveTicket(db, ticket) {
  const active = resolveActiveTicket(ticket);
  if (!active) return null;
  const [enriched] = enrichTicketsWithLocalData(db, [active]);
  return mapActiveTicket(enriched);
}

async function loadActiveTicketForRequest(db, req) {
  const responsibleUserId = String(req.query.responsible_user_id || '').trim();
  const activeForUserId =
    responsibleUserId || resolveSessionRegosUserId(db, req) || null;
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

function buildDurationSummary(tickets, channelSettings) {
  const callChannelIds = new Set(
    (channelSettings || [])
      .filter((setting) => setting.interaction_mode === 'call')
      .map((setting) => String(setting.channel_id))
  );
  const messageTickets = [];
  const calls = [];

  for (const ticket of tickets || []) {
    const channelId = ticket?.channel_id == null ? '' : String(ticket.channel_id);
    if (!callChannelIds.has(channelId)) {
      messageTickets.push(ticket);
      continue;
    }
    calls.push({
      id: ticket.id,
      slaBreached: Boolean(ticket.sla_breached),
      rated: ticket.rating != null,
      hasRecording: Boolean(getTicketRecordingUrl(ticket)),
    });
  }

  return {
    base: summarizeTickets(messageTickets),
    calls,
  };
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
  const recordingUrlCache = new Map();

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

  router.get('/login', (_req, res) => sendPublicFile(res, publicDir, 'login.html'));
  router.get('/login.css', (_req, res) => sendPublicFile(res, publicDir, 'login.css'));
  router.get('/login.js', (_req, res) => sendPublicFile(res, publicDir, 'login.js'));

  router.get('/auth/telegram', (req, res) => {
    const creds = getAdminCredentials();
    if (!creds) {
      return res.status(503).send(
        'Admin credentials are not configured. Set BOT_ADMIN_LOGIN and BOT_ADMIN_PASSWORD in .env and restart the server.'
      );
    }

    const rawToken = String(req.query.token || '').trim();
    const consumed = consumeDashboardLoginToken(db, rawToken);
    if (!consumed) {
      return res.status(401).send('Ссылка недействительна или уже использована. Запросите новую через /open_dashboard.');
    }

    const botUser = getBotUserByTelegramId(db, consumed.telegramId);
    if (
      !isLinkedEmployee(botUser) ||
      !hasRight(db, consumed.telegramId, 'open_admin_dashboard')
    ) {
      return res.status(403).send('Доступ запрещён. Нет права на открытие админ-панели.');
    }

    setSessionCookie(res, creds, { type: 'telegram', telegramId: consumed.telegramId });
    return res.redirect('/bot-admin/');
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
      if (!botUser || botUser.role !== 'employee' || !botUser.admin_login || !botUser.password_hash) {
        return res.status(403).json({
          message: 'Смена логина и пароля недоступна для этой учётной записи.',
        });
      }

      const currentPassword = String(req.body?.current_password || '');
      if (!verifyAdminPassword(currentPassword, botUser.password_hash)) {
        return res.status(400).json({ message: 'Неверный текущий пароль.' });
      }

      const loginProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'login');
      const newPasswordRaw = req.body?.new_password;
      const passwordProvided = newPasswordRaw !== undefined && String(newPasswordRaw) !== '';

      if (!loginProvided && !passwordProvided) {
        return res.status(400).json({ message: 'Укажите новый логин и/или новый пароль.' });
      }

      const updates = {};
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
      return res.status(500).json({ message: 'Не удалось обновить учётные данные.' });
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
        const ticket = await findTicketById(created.id);
        if (!ticket) {
          return res.status(502).json({
            message: 'REGOS создал тикет, но не вернул его при повторном чтении.',
            ticket_id: created.id,
          });
        }
        cacheTicketRecordingUrl(ticket);
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

        const ticket = await findTicketById(current.id);
        if (!ticket) {
          return res.status(502).json({
            message: 'REGOS изменил тикет, но не вернул его при повторном чтении.',
          });
        }
        cacheTicketRecordingUrl(ticket);
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
      return res.json({ ticket });
    } catch (error) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status).json({ message: error.message });
      }
      console.error('Get ticket error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить тикет.' });
    }
  });

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
      const upstream = await fetch(recordingUrl, {
        headers: /^bytes=\d*-\d*$/i.test(range) ? { Range: range } : {},
        redirect: 'manual',
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
      const fromEnd =
        req.query.from_end === '1' ||
        req.query.from_end === 'true' ||
        String(req.query.from_end || '').toLowerCase() === 'yes';

      let offset = Math.max(0, Number(req.query.offset) || 0);
      if (fromEnd && req.query.offset == null) {
        const probe = await getTicketMessages(chatId, {
          limit: 1,
          offset: 0,
          includeStaffPrivate: true,
        });
        offset = Math.max(0, (probe.total || 0) - limit);
      }

      const page = await getTicketMessages(chatId, {
        limit,
        offset,
        includeStaffPrivate: true,
      });

      return res.json({
        chat_id: chatId,
        messages: page.result,
        next_offset: page.next_offset,
        total: page.total,
        offset: page.offset,
        has_older: page.offset > 0,
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
    express.json(),
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

        const text = String(req.body?.text || '').trim();
        if (!text) {
          return res.status(400).json({ message: 'Введите текст сообщения.' });
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

        const created = await addTicketMessage({
          chatId,
          text,
          authorEntityId: regosUserId,
          authorEntityType: 'User',
        });
        return res.status(201).json({
          id: created.id,
          chat_id: chatId,
          author_entity_id: regosUserId,
        });
      } catch (error) {
        if (error instanceof RegosCrmError) {
          return res.status(error.status).json({ message: error.message });
        }
        console.error('Send ticket message error:', error);
        return res.status(500).json({ message: 'Не удалось отправить сообщение.' });
      }
    }
  );

  router.get(
    '/api/firm-search',
    requireAnyRight(db, ['tickets_read', 'clients_link_firm']),
    (req, res) => {
      const q = String(req.query.q || '').trim();
      if (!q) {
        return res.status(400).json({ message: 'Укажите поисковый запрос.' });
      }
      try {
        const result = searchFirmAdmin(q, db);
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

  router.get('/api/firms/:type/:recordId', requireRight(db, 'tickets_read'), (req, res) => {
    try {
      const firm = getFirmCardByTypeAndId(db, req.params.type, req.params.recordId);
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
    const fromDate = String(req.query.from_date || '').trim();
    const toDate = String(req.query.to_date || '').trim();
    let { page, limit, offset } = parsePaginationQuery(req);
    const options = {
      query: query || undefined,
      clientPhone: clientPhone || undefined,
      status: status || undefined,
      from: fromDate || undefined,
      to: toDate || undefined,
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
    });
  });

  router.post('/api/orders/:id/delete', requireRight(db, 'delete_unpaid_order'), (req, res) => {
    const orderId = String(req.params.id || '').trim();
    if (!orderId) {
      return res.status(400).json({ message: 'Не указан ID заказа.' });
    }
    const deleted = deletePendingOrder(db, orderId, resolveActorTelegramId(db, req));
    if (!deleted) {
      return res.status(409).json({
        message: 'Не удалось удалить заказ. Возможно, он уже оплачен или удалён.',
      });
    }
    return res.json({ ok: true, message: 'Неоплаченный заказ удалён.' });
  });

  router.post('/api/orders/:id/paid-cash', requireRight(db, 'mark_paid_cash'), (req, res) => {
    const orderId = String(req.params.id || '').trim();
    if (!orderId) {
      return res.status(400).json({ message: 'Не указан ID заказа.' });
    }
    const closed = markPendingOrderPaidCash(db, orderId, resolveActorTelegramId(db, req));
    if (!closed) {
      return res.status(409).json({
        message: 'Не удалось закрыть заказ. Возможно, он уже оплачен или удалён.',
      });
    }
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
      const recordIdRaw = req.body?.record_id;
      const recordId =
        recordIdRaw == null || recordIdRaw === '' ? null : recordIdRaw;
      const hasFirm = Boolean(clientType || recordId != null || firmMessage);

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

      const outboundBot = getOutboundBot();
      if (outboundBot) {
        try {
          await outboundBot.sendMessage(
            botUser.telegram_id,
            formatOrderPaymentMessage(detailedOrder, paymentPageUrl, paymentUrl)
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

      return res.status(201).json({
        order: detailedOrder,
        payment_page_url: paymentPageUrl,
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

      const activeForUserId =
        responsibleUserId || resolveSessionRegosUserId(db, req) || null;

      const ticketsPromise = fetchAllTickets({
        search: q || undefined,
        filters: filters.length ? filters : undefined,
        sort_orders: [{ column: 'created_date', direction: 'DESC' }],
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

      const summary = summarizeTickets(tickets);
      const durationSummary = durationFilterActive
        ? buildDurationSummary(tickets, listRegosChannelSettings(db))
        : null;
      if (durationSummary) {
        tickets.forEach(cacheTicketRecordingUrl);
      }
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
      await resolveMissingTicketRecordings(db, pageTickets);
      for (const ticket of pageTickets) {
        const href = ticket?.local?.recording?.url;
        if (href) {
          seedRecordingUrlCache(recordingUrlCache, ticket.id, href);
        } else {
          cacheTicketRecordingUrl(ticket);
        }
      }

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
      const prices = updateTechnicalSupportPrices(db, req.body?.prices || req.body || {});
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
      const catalog = replaceServicePricesCatalog(db, req.body || {});
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
        rights: parseRightsBody(req.body?.rights || req.body),
        adminLogin: parseOptionalCredential(req.body?.admin_login),
        password: parseOptionalCredential(req.body?.password),
      });

      const hasExplicitRegos = Object.prototype.hasOwnProperty.call(req.body || {}, 'regos_user_id');
      user = await applyRegosLinkToUser(db, user.id, {
        regosUserId: hasExplicitRegos ? req.body.regos_user_id : undefined,
        autoLink: !hasExplicitRegos || req.body?.auto_link_regos !== false,
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
      const updates = {
        phone: req.body?.phone,
        displayName: req.body?.display_name,
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
      let user = convertCustomerToEmployee(db, userId, {
        displayName: req.body?.display_name,
        rights: parseRightsBody(req.body?.rights || req.body),
        adminLogin: parseOptionalCredential(req.body?.admin_login),
        password: parseOptionalCredential(req.body?.password),
      });

      const hasExplicitRegos = Object.prototype.hasOwnProperty.call(req.body || {}, 'regos_user_id');
      user = await applyRegosLinkToUser(db, user.id, {
        regosUserId: hasExplicitRegos ? req.body.regos_user_id : undefined,
        autoLink: !hasExplicitRegos || req.body?.auto_link_regos !== false,
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
          return res.json({ user: mapUserResponse(linked), match: 'phone' });
        }

        const linked = await applyRegosLinkToUser(db, userId, {
          regosUserId: req.body.regos_user_id,
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
      deleteEmployeeUser(db, userId);
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

  router.get('/order-logs', requireRight(db, 'order_logs_read'), (_req, res) => {
    return sendPublicFile(res, publicDir, 'order-logs.html');
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
    const actor = getSessionActor(req);
    const permissions = getSessionPermissions(db, actor);
    if (!permissions.users_read) {
      if (permissions.orders_read) return res.redirect('/bot-admin/orders');
      if (permissions.order_logs_read) return res.redirect('/bot-admin/order-logs');
      if (permissions.tickets_read) return res.redirect('/bot-admin/tickets');
      if (permissions.technical_support_read) return res.redirect('/bot-admin/technical-support');
      if (permissions.prices_read) return res.redirect('/bot-admin/prices');
      if (permissions.settings_read) return res.redirect('/bot-admin/settings');
    }
    return sendPublicFile(res, publicDir, 'index.html');
  });

  router.use(requireAdminAuth, express.static(publicDir, { index: false }));

  return router;
}

module.exports = {
  createBotAdminRouter,
  buildDurationSummary,
};
