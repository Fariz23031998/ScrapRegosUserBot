import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { createEmployeeUser, updateEmployeeUser, convertCustomerToEmployee, deleteEmployeeUser, getBotUserById, getEmployeeWithRights, setBotUserRegosLink, clearBotUserRegosLink, listEmployeeUsers } from '../db/bot-users-db';
import { buildAuditDetails } from '../db/admin-audit-logs';
import { requireRight } from './bot-admin-auth';
import { RegosCrmError, fetchAllUsers, mapRegosUserSummary, matchPhoneToRegosUser, planRegosLinksByPhone } from '../integrations/regos-crm';
import { parseRightsBody, mapUserResponse, snapshotUserForAudit, parseOptionalCredential, applyRegosLinkToUser, mapRegosLinkError, auditAdminChange } from './bot-admin-shared';

export function registerBotAdminUserRoutes(router: any, deps: { db: Db }) {
  const { db } = deps;
  router.get('/api/regos-users', requireRight(db, 'users_read'), async (_req: any, res: Response) => {
    try {
      const users = await fetchAllUsers({ activeOnly: true });
      return res.json({
        users: users.map(mapRegosUserSummary),
      });
    } catch (error: any) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status!).json({ message: error.message });
      }
      console.error('List REGOS users error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить пользователей REGOS.' });
    }
  });

  router.post('/api/users', requireRight(db, 'users_create'), express.json(), async (req: Request, res: Response) => {
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
        schedule: req.body?.schedule,
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
    } catch (error: any) {
      const mapped = mapRegosLinkError(error);
      if (mapped) {
        return res.status(mapped.status).json({ message: mapped.message });
      }
      if (error.message === 'INVALID_EMPLOYEE_SCHEDULE') {
        return res.status(400).json({
          message: 'Некорректный график работы. Укажите время начала и окончания в пределах одного дня.',
        });
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

  router.put('/api/users/:id', requireRight(db, 'users_edit'), express.json(), async (req: Request, res: Response) => {
    try {
      const userId = Number(req.params.id);
      const beforeUser =
        getEmployeeWithRights(db, userId) || getBotUserById(db, userId);
      const updates: Unchecked = {
        phone: req.body?.phone,
        displayName: req.body?.display_name,
        jobTitle: req.body?.job_title,
        description: req.body?.description,
        rights: req.body?.rights ? parseRightsBody(req.body.rights) : parseRightsBody(req.body),
      };
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'schedule')) {
        updates.schedule = req.body.schedule;
      }
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
        before!.password = beforeUser?.password_hash ? '[задано]' : null;
        after!.password = '[изменено]';
      }
      auditAdminChange(db, req, {
        entityType: 'user',
        entityId: userId,
        action: 'update',
        summary: `Изменён сотрудник #${userId}`,
        details: buildAuditDetails({ before, after }),
      });

      return res.json({ user: mapUserResponse(user) });
    } catch (error: any) {
      const mapped = mapRegosLinkError(error);
      if (mapped) {
        return res.status(mapped.status).json({ message: mapped.message });
      }
      if (error.message === 'INVALID_EMPLOYEE_SCHEDULE') {
        return res.status(400).json({
          message: 'Некорректный график работы. Укажите время начала и окончания в пределах одного дня.',
        });
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

  router.post('/api/users/:id/promote', requireRight(db, 'users_edit'), express.json(), async (req: Request, res: Response) => {
    try {
      const userId = Number(req.params.id);
      const beforeUser = getBotUserById(db, userId);
      let user = convertCustomerToEmployee(db, userId, {
        displayName: req.body?.display_name,
        jobTitle: req.body?.job_title,
        description: req.body?.description,
        schedule: req.body?.schedule,
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
    } catch (error: any) {
      const mapped = mapRegosLinkError(error);
      if (mapped) {
        return res.status(mapped.status).json({ message: mapped.message });
      }
      if (error.message === 'INVALID_EMPLOYEE_SCHEDULE') {
        return res.status(400).json({
          message: 'Некорректный график работы. Укажите время начала и окончания в пределах одного дня.',
        });
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
    async (req: Request, res: Response) => {
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
          const used: Set<any> = new Set(
            listEmployeeUsers(db)
              .filter((user?: any) => user.id !== userId && user.regos_user_id != null)
              .map((user?: any) => Number(user.regos_user_id))
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
      } catch (error: any) {
        const mapped = mapRegosLinkError(error);
        if (mapped) {
          return res.status(mapped.status).json({ message: mapped.message });
        }
        console.error('Link REGOS user error:', error);
        return res.status(500).json({ message: 'Не удалось привязать пользователя REGOS.' });
      }
    }
  );

  router.delete('/api/users/:id/regos-link', requireRight(db, 'users_edit'), (req: Request, res: Response) => {
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
    } catch (error: any) {
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
    async (req: Request, res: Response) => {
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
        const items: any[] = [];

        for (const item of plan) {
          (summary as Record<string, number>)[item.status] = ((summary as Record<string, number>)[item.status] || 0) + 1;
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
      } catch (error: any) {
        if (error instanceof RegosCrmError) {
          return res.status(error.status!).json({ message: error.message });
        }
        console.error('Auto-link REGOS users error:', error);
        return res.status(500).json({ message: 'Не удалось выполнить автосопоставление с REGOS.' });
      }
    }
  );

  router.delete('/api/users/:id', requireRight(db, 'users_delete'), (req: Request, res: Response) => {
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
    } catch (error: any) {
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

}
