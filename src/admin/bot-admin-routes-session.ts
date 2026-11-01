import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { updateEmployeeUser, listBotUsers, findEmployeeByAdminLogin, verifyAdminPassword, getBotUserById, getBotUserByTelegramId } from '../db/bot-users-db';
import { RIGHTS, hasRight, isLinkedEmployee } from '../db/user-rights';
import { buildAuditDetails, buildFieldChanges } from '../db/admin-audit-logs';
import { getAdminCredentials, getSessionActor, getSessionPermissions, setSessionCookie, clearSessionCookie, requireAdminAuth, requireRight } from './bot-admin-auth';
import { consumeDashboardLoginToken, lookupDashboardLoginToken, hasActiveDashboardSession, invalidateDashboardLoginTokensForTelegramId } from './dashboard-login-tokens';
import { getTelegramBotToken, parseTelegramWebAppInitData } from './telegram-webapp-auth';
import { resolveSessionBotUser, displayNameForBotUser, buildSessionProfile, mapUserResponse, parsePaginationQuery, auditAdminChange } from './bot-admin-shared';

export function registerBotAdminSessionRoutes(router: any, deps: { db: Db }) {
  const { db } = deps;
  router.get('/auth/telegram', (req: Request, res: Response) => {
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

  router.post('/api/auth/telegram-webapp', express.json(), (req: Request, res: Response) => {
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

    const token = setSessionCookie(res, creds, { type: 'telegram', telegramId });
    return res.json({ ok: true, token });
  });

  router.get('/api/session', (req: Request, res: Response) => {
    if (!getAdminCredentials()) {
      return res.status(503).json({ message: 'Admin credentials are not configured.' });
    }
    const actor = getSessionActor(req);
    if (!actor) {
      return res.status(401).json({ message: 'Требуется вход в систему.' });
    }

    let botUser: any = null;
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

  router.patch('/api/account', requireAdminAuth, express.json(), (req: Request, res: Response) => {
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

      const updates: Unchecked = {};
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
      } catch (error: any) {
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
    } catch (error: any) {
      console.error('Update account error:', error);
      return res.status(500).json({ message: 'Не удалось обновить профиль.' });
    }
  });

  router.post('/api/login', express.json(), (req: Request, res: Response) => {
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
      const token = setSessionCookie(res, creds, { type: 'password' });
      return res.json({ ok: true, token });
    }

    const employee = findEmployeeByAdminLogin(db, login);
    if (employee && verifyAdminPassword(password, employee.password_hash)) {
      const token = setSessionCookie(res, creds, { type: 'user', userId: employee.id });
      return res.json({ ok: true, token });
    }

    return res.status(401).json({ message: 'Неверный логин или пароль.' });
  });

  router.post('/api/logout', (req: Request, res: Response) => {
    const actor = getSessionActor(req);
    if (actor?.type === 'telegram' && actor.telegramId) {
      invalidateDashboardLoginTokensForTelegramId(db, actor.telegramId);
    }
    clearSessionCookie(res);
    return res.json({ ok: true });
  });

  router.get('/rights-meta', requireRight(db, 'users_read'), (_req: any, res: Response) => {
    res.json({
      rights: Object.entries(RIGHTS).map(([key, value]: [string, any]) => ({
        key,
        label: value.label,
      })),
    });
  });

  router.get('/api/users', requireRight(db, 'users_read'), (req: Request, res: Response) => {
    const role = String(req.query.role || '').trim();
    const query = String(req.query.q || '').trim();
    let { page, limit, offset } = parsePaginationQuery(req);
    const options: Unchecked = { offset, limit };
    if (role === 'employee' || role === 'customer') {
      options.role = role;
    }
    if (query) {
      options.query = query;
    }
    if (req.query.sort) options.sort = req.query.sort;
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

}
