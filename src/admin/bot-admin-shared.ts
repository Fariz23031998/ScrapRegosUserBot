import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { getBotUserById, getEmployeeWithRights, setBotUserRegosLink, clearBotUserRegosLink, listEmployeeUsers, getBotUserByTelegramId } from '../db/bot-users-db';
import { parseSchedule } from '../lib/employee-schedule';
import { RIGHTS } from '../db/user-rights';
import { formatPaymentProviderLabel } from '../db/order-logs';
import { logAdminAudit } from '../db/admin-audit-logs';
import { getAdminCredentials, getSessionActor } from './bot-admin-auth';
import { enrichTicketsWithLocalData } from './ticket-local-enrichment';
import { listRegosChannelSettings, mergeRegosChannelsWithSettings } from '../db/regos-channel-settings';
import { RegosCrmError, fetchAllUsers, fetchAllChannels, mapRegosUserSummary, mapRegosChannelSummary, matchPhoneToRegosUser, findLatestTicketForResponsibleUser, resolveActiveTicket, mapActiveTicket } from '../integrations/regos-crm';
import { botAdminUiDistDir } from '../paths';
import { sendVersionedHtmlFile } from '../http/asset-cache';
import { isAbortError } from '../ai/run-agent';
import { MAX_IMAGES_PER_ARTICLE, MAX_IMAGE_BYTES } from '../db/knowledge-images';

export function isAiCredentialError(error: Error) {
  const message = String(error?.message || '');
  return (
    message === 'OPENAI_API_KEY is not configured' ||
    message === 'GEMINI_API_KEY is not configured' ||
    /OPENAI_API_KEY|GEMINI_API_KEY/.test(message)
  );
}

export function aiCredentialErrorMessage(error: Error) {
  const message = String(error?.message || '');
  if (message.includes('GEMINI')) {
    return 'AI не настроен. Укажите API-ключ Gemini в настройках или GEMINI_API_KEY.';
  }
  return 'AI не настроен. Укажите API-ключ OpenAI в настройках или OPENAI_API_KEY.';
}

export function providerErrorDetail(error: any) {
  const message = String(error?.error?.message || error?.message || '').trim();
  if (!message || message.length > 280) return '';
  if (/api[_-]?key|authorization|bearer/i.test(message)) return '';
  if (message === 'AI_TIMEOUT' || isAbortError(error)) return '';
  return message;
}

export function mapAgentChatError(error: Error, fallback?: any) {
  if (error?.message === 'EMPTY_MESSAGE') {
    return 'Введите текст сообщения или прикрепите файл.';
  }
  if (isAiCredentialError(error)) return aiCredentialErrorMessage(error);
  if (isAbortError(error)) {
    return 'Агент не успел ответить вовремя. Попробуйте ещё раз.';
  }
  const detail = providerErrorDetail(error);
  if (detail && detail !== fallback) {
    return `${fallback.replace(/\.$/, '')}: ${detail}`;
  }
  return fallback;
}

export function knowledgeImageErrorMessage(code?: any) {
  if (code === 'INVALID_IMAGE_TYPE') return 'Загрузите изображение JPEG, PNG, WebP или GIF.';
  if (code === 'INVALID_IMAGE_SIZE') return 'Изображение слишком большое. Максимум 5 МБ.';
  if (code === 'IMAGE_LIMIT_REACHED') return 'Можно прикрепить не больше 20 изображений.';
  if (code === 'INVALID_IMAGE_URL') return 'Не удалось загрузить изображение по ссылке.';
  return null;
}

export const knowledgeImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES_PER_ARTICLE },
});

export function handleKnowledgeImageUpload(req: Request, res: Response, next: NextFunction) {
  knowledgeImageUpload.array('image', MAX_IMAGES_PER_ARTICLE)(req, res, (error: any) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ message: knowledgeImageErrorMessage('INVALID_IMAGE_SIZE') });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ message: knowledgeImageErrorMessage('IMAGE_LIMIT_REACHED') });
    }
    return res.status(400).json({ message: knowledgeImageErrorMessage('INVALID_IMAGE_TYPE') });
  });
}

export function parseRightsBody(body: any = {}) {
  const rights: Unchecked = {};
  for (const key of Object.keys(RIGHTS)) {
    if (body[key] !== undefined) {
      rights[key] = body[key] ? 1 : 0;
    }
  }
  return rights;
}

export async function loadMergedChannelSettings(db: Db) {
  const channels = (await fetchAllChannels()).map(mapRegosChannelSummary);
  return mergeRegosChannelsWithSettings(channels, listRegosChannelSettings(db));
}

export function resolveSessionRegosUserId(db: Db, req: Request) {
  const actor = getSessionActor(req);
  if (!actor) return null;
  let botUser: any = null;
  if (actor.type === 'telegram') {
    botUser = getBotUserByTelegramId(db, actor.telegramId);
  } else if (actor.type === 'user') {
    botUser = getBotUserById(db, actor.userId);
  }
  return botUser?.regos_user_id != null ? Number(botUser.regos_user_id) : null;
}

export function resolveSessionBotUser(db: Db, req: Request) {
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

export function displayNameForBotUser(botUser?: any) {
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

export function buildSessionProfile(db: Db, actor?: any) {
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

export function mapUserResponse(user?: any) {
  return {
    id: user.id,
    role: user.role,
    phone: user.phone,
    display_name: user.display_name,
    job_title: user.job_title || null,
    description: user.description || null,
    schedule: parseSchedule(user.schedule),
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

export function snapshotUserForAudit(user?: any): Unchecked | null {
  if (!user) return null;
  return {
    id: user.id,
    role: user.role ?? null,
    phone: user.phone ?? null,
    display_name: user.display_name ?? null,
    job_title: user.job_title ?? null,
    description: user.description ?? null,
    schedule: parseSchedule(user.schedule),
    admin_login: user.admin_login || null,
    has_password: Boolean(user.password_hash || user.has_password),
    regos_user_id: user.regos_user_id ?? null,
    regos_login: user.regos_login || null,
    regos_full_name: user.regos_full_name || null,
    rights: user.rights || null,
  };
}

export function snapshotOrderForAudit(order?: any) {
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

export function snapshotPricesForAudit(prices?: any) {
  if (!Array.isArray(prices)) return null;
  return prices.map((row?: any) => ({
    months: row.months,
    amount: row.amount,
    configured: row.configured,
  }));
}

export function snapshotCatalogForAudit(catalog?: any) {
  if (!catalog || typeof catalog !== 'object') return null;
  return {
    title_ru: catalog.title_ru ?? null,
    title_uz: catalog.title_uz ?? null,
    categories_count: Array.isArray(catalog.categories) ? catalog.categories.length : 0,
    items_count: Array.isArray(catalog.categories)
      ? catalog.categories.reduce(
          (sum?: any, category?: any) => sum + (Array.isArray(category.items) ? category.items.length : 0),
          0
        )
      : 0,
    categories: Array.isArray(catalog.categories)
      ? catalog.categories.map((category?: any) => ({
          name_ru: category.name_ru ?? null,
          name_uz: category.name_uz ?? null,
          items_count: Array.isArray(category.items) ? category.items.length : 0,
        }))
      : [],
  };
}

export function parseOptionalCredential(value?: any) {
  if (value === undefined || value === null) return undefined;
  return String(value);
}

export function summarizeRegosUser(user?: any) {
  return mapRegosUserSummary(user);
}

export async function resolveRegosUserById(regosUserId?: any) {
  const id = Number(regosUserId);
  if (!Number.isFinite(id) || id <= 0) {
    throw Object.assign(new Error('INVALID_REGOS_USER'), { code: 'INVALID_REGOS_USER' });
  }
  const users = await fetchAllUsers({ activeOnly: false });
  const found = users.find((user?: any) => Number(user.id) === id);
  if (!found) {
    throw Object.assign(new Error('REGOS_USER_NOT_FOUND'), { code: 'REGOS_USER_NOT_FOUND' });
  }
  return found;
}

export async function buildRegosUserNameMap() {
  const users = await fetchAllUsers({ activeOnly: false });
  const userNames: Unchecked = {};
  for (const user of users) {
    const id = Number(user.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    userNames[id] = user.full_name || user.login || `Пользователь #${id}`;
  }
  return userNames;
}

export async function applyRegosLinkToUser(db: Db, userId: any, { regosUserId, autoLink = false }: Unchecked = {}) {
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
  const used: Set<any> = new Set(
    listEmployeeUsers(db)
      .map((user?: any) => Number(user.regos_user_id))
      .filter((id?: any) => Number.isFinite(id))
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

export function mapRegosLinkError(error: Error) {
  const code = error.code || error.message;
  const messages = {
    INVALID_REGOS_USER: 'Некорректный пользователь REGOS.',
    REGOS_USER_NOT_FOUND: 'Пользователь REGOS не найден.',
    REGOS_USER_LINKED: 'Этот пользователь REGOS уже привязан к другому сотруднику бота.',
    NOT_FOUND: 'Пользователь не найден.',
  };
  const message = (messages as Record<string, string>)[code];
  if (message) {
    return { status: code === 'NOT_FOUND' ? 404 : 400, message };
  }
  if (error instanceof RegosCrmError) {
    return { status: error.status!, message: error.message };
  }
  return null;
}

export function sendPublicFile(res: Response, publicDir?: any, filename?: any) {
  const absolutePath = path.join(publicDir, filename);
  if (String(filename).toLowerCase().endsWith('.html')) {
    return sendVersionedHtmlFile(res, absolutePath);
  }
  return res.sendFile(absolutePath);
}

export function botAdminReactUiIndexPath() {
  return path.join(botAdminUiDistDir(), 'index.html');
}

/** React SPA is the default UI when `bot-admin-ui/dist` is built. */
export function isBotAdminReactUiReady() {
  if (String(process.env.BOT_ADMIN_USE_LEGACY_UI || '').trim() === '1') {
    return false;
  }
  return fs.existsSync(botAdminReactUiIndexPath());
}

export function sendBotAdminReactUiIndex(res: Response) {
  return res.sendFile(botAdminReactUiIndexPath());
}

export function isBotAdminSpaPath(reqPath?: any) {
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

export function parsePaginationQuery(req: Request) {
  const allowedLimits = [10, 25, 50, 100];
  let limit = Number(req.query.limit) || 25;
  if (!allowedLimits.includes(limit)) {
    limit = 25;
  }
  const page = Math.max(Number(req.query.page) || 1, 1);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

export const ORDER_STATUS_LABELS = {
  pending: 'Неоплачен',
  paid: 'Оплачен',
  paid_cash: 'Оплачен',
  deleted: 'Удалён',
};

export function isPaidOrderStatus(status?: any) {
  return status === 'paid' || status === 'paid_cash';
}

export function mapAdminOrderRow(order?: any) {
  const paymentProvider = isPaidOrderStatus(order.status) ? order.payment_provider ?? null : null;
  return {
    id: order.id,
    status: order.status,
    status_label: (ORDER_STATUS_LABELS as Record<string, string>)[order.status] || order.status,
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

export function resolveActorTelegramId(db: Db, req: Request) {
  const botUser = resolveSessionBotUser(db, req);
  return botUser?.telegram_id != null ? botUser.telegram_id : null;
}

export function auditAdminChange(db: Db, req: Request, { entityType, entityId, action, summary, details }: Unchecked) {
  try {
    logAdminAudit(db, {
      entityType,
      entityId,
      action,
      summary,
      details,
      actor: getSessionActor(req),
    });
  } catch (error: any) {
    console.error('[bot-admin] Audit log write failed:', error);
  }
}

export function mapEnrichedActiveTicket(db: Db, ticket?: any) {
  const active = resolveActiveTicket(ticket);
  if (!active) return null;
  const [enriched] = enrichTicketsWithLocalData(db, [active]);
  return mapActiveTicket(enriched);
}

export async function loadActiveTicketForRequest(db: Db, req: Request) {
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

export function resolveKnowledgeActorUserId(db: Db, req: Request) {
  const actor = getSessionActor(req);
  if (actor?.type === 'user') return Number(actor.userId) || null;
  if (actor?.type === 'telegram') {
    const user = getBotUserByTelegramId(db, actor.telegramId);
    return user?.id ?? null;
  }
  return null;
}
