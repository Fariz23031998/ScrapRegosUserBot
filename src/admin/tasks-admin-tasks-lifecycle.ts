import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { requireRight } from './bot-admin-auth';
import { listTasks, postTask, unpostTask, advanceTaskStatus } from '../db/tasks';
import { scheduleTaskAssignmentNotify } from '../bot/task-assignment-notify';
import { listTaskRefunds } from '../db/task-refunds';
import { parsePaginationQuery, taskWriteErrorMessage, respondWriteError } from './tasks-admin-shared';

export function registerTaskLifecycleRoutes(router: any, deps: { db: Db; auditAdminChange: (db: Db, req: Request, entry: Unchecked) => void; buildAuditDetails: (...args: any[]) => any; taskViewer: (req: Request) => any; sessionUserId: (req: Request) => any; visibleTask: (req: Request, id?: any) => any; requireVisibleTask: (req: Request, res: Response) => any }) {
  const { db, auditAdminChange, buildAuditDetails, taskViewer, sessionUserId, visibleTask, requireVisibleTask } = deps;
  router.get('/api/tasks', requireRight(db, 'tasks_read'), (req: Request, res: Response) => {
    try {
      const query = String(req.query.q || '').trim();
      const status = String(req.query.status || '').trim();
      const categoryId = String(req.query.category_id || '').trim();
      const locationId = String(req.query.location_id || '').trim();
      const viewer = taskViewer(req);
      let { page, limit, offset } = parsePaginationQuery(req);
      let result = listTasks(db, {
        query,
        status: status || undefined,
        categoryId: categoryId || undefined,
        locationId: locationId || undefined,
        viewer,
        offset,
        limit,
        sort: req.query.sort,
      });
      const totalPages = Math.max(1, Math.ceil(Number(result!.total) / limit) || 1);
      if (page > totalPages) {
        page = totalPages;
        offset = (page - 1) * limit;
        result = listTasks(db, {
          query,
          status: status || undefined,
          categoryId: categoryId || undefined,
          locationId: locationId || undefined,
          viewer,
          offset,
          limit,
          sort: req.query.sort,
        });
      }
      return res.json({
        tasks: result.tasks,
        total: result.total,
        page,
        limit,
      });
    } catch (error: any) {
      const mapped = taskWriteErrorMessage(error.message);
      if (mapped) return res.status(400).json({ message: mapped });
      console.error('List tasks error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить задачи.' });
    }
  });

  router.get('/api/tasks/:id', requireRight(db, 'tasks_read'), (req: Request, res: Response) => {
    const task = visibleTask(req);
    if (!task) return res.status(404).json({ message: 'Задача не найдена.' });
    return res.json({ task });
  });

  router.post('/api/tasks/:id/post', requireRight(db, 'tasks_post'), (req: Request, res: Response) => {
    try {
      const before = requireVisibleTask(req, res);
      if (!before) return;
      const task = postTask(db, before.id, taskViewer(req));
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: task!.id,
        action: 'update',
        summary: `Проведена задача #${task!.id}`,
        details: buildAuditDetails({ before, after: task }),
      });
      return res.json({ task });
    } catch (error: any) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Задача не найдена.' : 'Не удалось провести задачу.',
        taskWriteErrorMessage
      );
    }
  });

  router.post('/api/tasks/:id/unpost', requireRight(db, 'tasks_unpost'), express.json(), (req: Request, res: Response) => {
    try {
      const before = requireVisibleTask(req, res);
      if (!before) return;
      const deleteRefunds = Boolean(req.body?.delete_refunds);
      const deleteReturns = Boolean(req.body?.delete_returns);
      const refundCount = Array.isArray(before.refunds) ? before.refunds.length : 0;
      const hasDeviceReturns = (before.devices || []).some(
        (line?: any) => (Number(line.returned_quantity) || 0) > 0
      );
      const task = unpostTask(db, before.id, taskViewer(req), { deleteRefunds, deleteReturns });
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: task!.id,
        action: 'update',
        summary:
          (refundCount > 0 && deleteRefunds) || (hasDeviceReturns && deleteReturns)
            ? `Отменено проведение задачи #${task!.id}: удалены возвраты`
            : `Отменено проведение задачи #${task!.id}`,
        details: buildAuditDetails({ before, after: task }),
      });
      return res.json({ task });
    } catch (error: any) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Задача не найдена.' : 'Не удалось отменить проведение задачи.',
        taskWriteErrorMessage
      );
    }
  });

  router.post('/api/tasks/:id/status/next', requireRight(db, 'tasks_edit'), (req: Request, res: Response) => {
    try {
      const before = requireVisibleTask(req, res);
      if (!before) return;
      const task = advanceTaskStatus(db, before.id, taskViewer(req), {
        actorUserId: sessionUserId(req),
      });
      scheduleTaskAssignmentNotify(db, {
        before,
        after: task,
        actorUserId: sessionUserId(req),
      });
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: task!.id,
        action: 'update',
        summary: `Статус задачи #${task!.id}: ${before.status_label || before.status} → ${task!.status_label || task!.status}`,
        details: buildAuditDetails({ before, after: task }),
      });
      return res.json({ task });
    } catch (error: any) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Задача не найдена.' : 'Не удалось изменить статус задачи.',
        taskWriteErrorMessage
      );
    }
  });

  router.get('/api/tasks/:id/refunds', requireRight(db, 'tasks_read'), (req: Request, res: Response) => {
    const task = visibleTask(req);
    if (!task) return res.status(404).json({ message: 'Задача не найдена.' });
    return res.json({ refunds: listTaskRefunds(db, task.id) });
  });

}
