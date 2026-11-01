import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { requireRight, requireAnyRight } from './bot-admin-auth';
import { listEmployeeUsers } from '../db/bot-users-db';
import { listLocationsForViewer, getLocation, listAllowedUsers } from '../db/locations';
import { listPaymentTypes } from '../db/payment-types';
import { listTaskCategories, getTaskCategory, createTaskCategory, updateTaskCategory, deleteTaskCategory } from '../db/tasks';
import { RegosCrmError, searchClients } from '../integrations/regos-crm';
import { previewTaskDistance } from '../db/task-distance';
import { mapEmployee, mapTaskClient, createMappedTaskClient, categoryWriteErrorMessage, taskWriteErrorMessage, respondWriteError } from './tasks-admin-shared';

export function registerTaskCatalogRoutes(router: any, deps: { db: Db; auditAdminChange: (db: Db, req: Request, entry: Unchecked) => void; buildAuditDetails: (...args: any[]) => any; taskViewer: (req: Request) => any }) {
  const { db, auditAdminChange, buildAuditDetails, taskViewer } = deps;
  router.get('/api/tasks/categories', requireRight(db, 'tasks_read'), (_req: any, res: Response) => {
    try {
      return res.json({ categories: listTaskCategories(db) });
    } catch (error: any) {
      console.error('List task categories error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить категории.' });
    }
  });

  router.post('/api/tasks/categories', requireRight(db, 'tasks_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const category = createTaskCategory(db, { name: req.body?.name });
      auditAdminChange(db, req, {
        entityType: 'task_category',
        entityId: category!.id,
        action: 'create',
        summary: `Создана категория задач «${category!.name}»`,
        details: buildAuditDetails({ before: null, after: category }),
      });
      return res.status(201).json({ category });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось создать категорию.', categoryWriteErrorMessage);
    }
  });

  router.put('/api/tasks/categories/:id', requireRight(db, 'tasks_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const before = getTaskCategory(db, req.params.id);
      const category = updateTaskCategory(db, req.params.id, { name: req.body?.name });
      auditAdminChange(db, req, {
        entityType: 'task_category',
        entityId: category!.id,
        action: 'update',
        summary: `Изменена категория задач #${category!.id}`,
        details: buildAuditDetails({ before, after: category }),
      });
      return res.json({ category });
    } catch (error: any) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Категория не найдена.' : 'Не удалось обновить категорию.',
        categoryWriteErrorMessage
      );
    }
  });

  router.delete('/api/tasks/categories/:id', requireRight(db, 'tasks_edit'), (req: Request, res: Response) => {
    try {
      const before = getTaskCategory(db, req.params.id);
      const deleted = deleteTaskCategory(db, req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Категория не найдена.' });
      auditAdminChange(db, req, {
        entityType: 'task_category',
        entityId: before!.id,
        action: 'delete',
        summary: `Удалена категория задач «${before!.name}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось удалить категорию.', categoryWriteErrorMessage);
    }
  });

  router.get('/api/tasks/employees', requireAnyRight(db, ['tasks_read', 'settings_read']), (req: Request, res: Response) => {
    try {
      const locationIdRaw = String(req.query.location_id || '').trim();
      let users = listEmployeeUsers(db);
      if (locationIdRaw) {
        const location = getLocation(db, locationIdRaw);
        if (!location) {
          return res.status(400).json({ message: taskWriteErrorMessage('INVALID_TASK_LOCATION') });
        }
        const allowedIds: Set<any> = new Set(listAllowedUsers(db, location.id).map((user?: any) => Number(user.id)));
        users = users.filter((user?: any) => allowedIds.has(Number(user.id)));
      }
      const employees = users.map(mapEmployee);
      employees.sort((a?: any, b?: any) => a.name.localeCompare(b.name, 'ru'));
      return res.json({ employees });
    } catch (error: any) {
      console.error('List task employees error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить сотрудников.' });
    }
  });

  router.get('/api/tasks/locations', requireRight(db, 'tasks_read'), (req: Request, res: Response) => {
    try {
      return res.json({ locations: listLocationsForViewer(db, taskViewer(req)) });
    } catch (error: any) {
      console.error('List task locations error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить филиалы.' });
    }
  });

  router.post(
    '/api/tasks/distance-preview',
    requireAnyRight(db, ['tasks_create', 'tasks_edit']),
    express.json(),
    async (req: Request, res: Response) => {
      try {
        const preview = await previewTaskDistance(db, {
          address: req.body?.address,
          location_id: req.body?.location_id,
        });
        return res.json(preview);
      } catch (error: any) {
        console.error('Task distance preview error:', error);
        return res.status(500).json({ message: 'Не удалось рассчитать дистанцию.' });
      }
    }
  );

  // Registered before '/api/tasks/:id' so Express does not treat it as a task id.
  router.get('/api/tasks/payment-types', requireRight(db, 'tasks_read'), (_req: any, res: Response) => {
    try {
      return res.json({ payment_types: listPaymentTypes(db) });
    } catch (error: any) {
      console.error('List task payment types error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить типы оплаты.' });
    }
  });

  router.get('/api/tasks/clients', requireRight(db, 'tasks_read'), async (req: Request, res: Response) => {
    try {
      const query = String(req.query.q || '').trim();
      if (query.length < 2) {
        return res.json({ clients: [] });
      }
      const clients = await searchClients(query, { limit: 20 });
      return res.json({ clients: clients.map(mapTaskClient) });
    } catch (error: any) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status!).json({ message: error.message });
      }
      console.error('Search task clients error:', error);
      return res.status(500).json({ message: 'Не удалось найти клиентов REGOS.' });
    }
  });

  router.post(
    '/api/tasks/clients',
    requireAnyRight(db, ['tasks_create', 'tasks_edit']),
    express.json(),
    async (req: Request, res: Response) => {
      try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const client = await createMappedTaskClient(body);
        auditAdminChange(db, req, {
          entityType: 'client',
          entityId: client.id,
          action: 'create',
          summary: `Создан клиент REGOS «${client.name || client.phone || client.id}»`,
          details: buildAuditDetails({ before: null, after: client }),
        });
        return res.status(201).json({ client });
      } catch (error: any) {
        if (error instanceof RegosCrmError) {
          return res.status(error.status!).json({ message: error.message });
        }
        console.error('Create task client error:', error);
        return res.status(500).json({ message: 'Не удалось создать клиента REGOS.' });
      }
    }
  );

}
