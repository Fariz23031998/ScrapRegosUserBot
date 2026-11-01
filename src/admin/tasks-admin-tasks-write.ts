import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { getSessionActor, requireRight, actorHasPermission } from './bot-admin-auth';
import { createTask, updateTask, deleteTask } from '../db/tasks';
import { scheduleTaskAssignmentNotify } from '../bot/task-assignment-notify';
import { taskWriteErrorMessage, respondWriteError } from './tasks-admin-shared';

export function registerTaskWriteRoutes(router: any, deps: { db: Db; auditAdminChange: (db: Db, req: Request, entry: Unchecked) => void; buildAuditDetails: (...args: any[]) => any; taskViewer: (req: Request) => any; sessionUserId: (req: Request) => any; applyTaskStaffPermissions: (req: Request, body: any, current?: any) => any; requireVisibleTask: (req: Request, res: Response) => any }) {
  const { db, auditAdminChange, buildAuditDetails, taskViewer, sessionUserId, applyTaskStaffPermissions, requireVisibleTask } = deps;
  router.post('/api/tasks', requireRight(db, 'tasks_create'), express.json(), (req: Request, res: Response) => {
    try {
      const body = { ...(req.body || {}) };
      if (!actorHasPermission(db, getSessionActor(req), 'tasks_status')) {
        delete body.status;
      }
      const staff = applyTaskStaffPermissions(req, body);
      if (staff.error) return res.status(403).json({ message: staff.error });
      const task = createTask(db, body, {
        requireLocation: true,
        viewer: taskViewer(req),
        actorUserId: sessionUserId(req),
      });
      scheduleTaskAssignmentNotify(db, {
        before: null,
        after: task,
        actorUserId: sessionUserId(req),
      });
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: task!.id,
        action: 'create',
        summary: `Создана задача «${task!.title}»`,
        details: buildAuditDetails({ before: null, after: task }),
      });
      return res.status(201).json({ task });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось создать задачу.', taskWriteErrorMessage);
    }
  });

  router.put('/api/tasks/:id', requireRight(db, 'tasks_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const before = requireVisibleTask(req, res);
      if (!before) return;
      const body = { ...(req.body || {}) };
      const statusChanging =
        body.status != null && String(body.status) !== String(before.status);
      const canChangeStatus = actorHasPermission(db, getSessionActor(req), 'tasks_status');
      if (statusChanging && !canChangeStatus) {
        return res.status(403).json({ message: 'Недостаточно прав для изменения статуса задачи.' });
      }
      if (!canChangeStatus) {
        delete body.status;
      }
      const staff = applyTaskStaffPermissions(req, body, before);
      if (staff.error) return res.status(403).json({ message: staff.error });
      const task = updateTask(db, req.params.id, body, {
        requireLocation: true,
        viewer: taskViewer(req),
        allowAnyStatus: statusChanging && canChangeStatus,
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
        summary: `Изменена задача #${task!.id}`,
        details: buildAuditDetails({ before, after: task }),
      });
      return res.json({ task });
    } catch (error: any) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Задача не найдена.' : 'Не удалось обновить задачу.',
        taskWriteErrorMessage
      );
    }
  });

  router.delete('/api/tasks/:id', requireRight(db, 'tasks_delete'), (req: Request, res: Response) => {
    try {
      const before = requireVisibleTask(req, res);
      if (!before) return;
      const deleted = deleteTask(db, req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Задача не найдена.' });
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: before.id,
        action: 'delete',
        summary: `Удалена задача «${before.title}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось удалить задачу.', taskWriteErrorMessage);
    }
  });

}
