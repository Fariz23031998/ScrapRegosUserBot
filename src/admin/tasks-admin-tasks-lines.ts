import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { getSessionActor, requireRight, actorHasPermission } from './bot-admin-auth';
import { addTaskDevice, updateTaskDevice, deleteTaskDevice, addTaskService, updateTaskService, deleteTaskService, applyTaskDiscount } from '../db/tasks';
import { createTaskPayment, deleteTaskPayment, getTaskPayment } from '../db/task-payments';
import { refundTaskLine, hasRefundPaymentInput } from '../db/task-refunds';
import { taskWriteErrorMessage, respondWriteError } from './tasks-admin-shared';

export function registerTaskLineRoutes(router: any, deps: { db: Db; auditAdminChange: (db: Db, req: Request, entry: Unchecked) => void; buildAuditDetails: (...args: any[]) => any; taskViewer: (req: Request) => any; sessionUserId: (req: Request) => any; visibleTask: (req: Request, id?: any) => any; requireVisibleTask: (req: Request, res: Response) => any }) {
  const { db, auditAdminChange, buildAuditDetails, taskViewer, sessionUserId, visibleTask, requireVisibleTask } = deps;
  router.post('/api/tasks/:id/devices', requireRight(db, 'tasks_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const before = requireVisibleTask(req, res);
      if (!before) return;
      const task = addTaskDevice(db, req.params.id, {
        device_id: req.body?.device_id,
        action: req.body?.action,
        notes: req.body?.notes,
      });
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: task!.id,
        action: 'update',
        summary: `Добавлено устройство в задачу #${task!.id}`,
        details: buildAuditDetails({ before, after: task }),
      });
      return res.status(201).json({ task });
    } catch (error: any) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Задача не найдена.' : 'Не удалось добавить устройство.',
        taskWriteErrorMessage
      );
    }
  });

  router.put('/api/tasks/:id/devices/:lineId', requireRight(db, 'tasks_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const before = requireVisibleTask(req, res);
      if (!before) return;
      const task = updateTaskDevice(db, req.params.id, req.params.lineId, {
        quantity: req.body?.quantity,
      });
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: task!.id,
        action: 'update',
        summary: `Изменено количество устройства в задаче #${task!.id}`,
        details: buildAuditDetails({ before, after: task }),
      });
      return res.json({ task });
    } catch (error: any) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Строка задачи не найдена.' : 'Не удалось обновить устройство.',
        taskWriteErrorMessage
      );
    }
  });

  router.delete('/api/tasks/:id/devices/:lineId', requireRight(db, 'tasks_edit'), (req: Request, res: Response) => {
    try {
      const before = requireVisibleTask(req, res);
      if (!before) return;
      const task = deleteTaskDevice(db, req.params.id, req.params.lineId);
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: task!.id,
        action: 'update',
        summary: `Удалено устройство из задачи #${task!.id}`,
        details: buildAuditDetails({ before, after: task }),
      });
      return res.json({ task });
    } catch (error: any) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Строка задачи не найдена.' : 'Не удалось удалить устройство.',
        taskWriteErrorMessage
      );
    }
  });

  router.post('/api/tasks/:id/services', requireRight(db, 'tasks_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const before = requireVisibleTask(req, res);
      if (!before) return;
      const task = addTaskService(db, req.params.id, {
        service_id: req.body?.service_id,
        notes: req.body?.notes,
      });
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: task!.id,
        action: 'update',
        summary: `Добавлена услуга в задачу #${task!.id}`,
        details: buildAuditDetails({ before, after: task }),
      });
      return res.status(201).json({ task });
    } catch (error: any) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Задача не найдена.' : 'Не удалось добавить услугу.',
        taskWriteErrorMessage
      );
    }
  });

  router.put('/api/tasks/:id/services/:lineId', requireRight(db, 'tasks_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const before = requireVisibleTask(req, res);
      if (!before) return;
      const task = updateTaskService(db, req.params.id, req.params.lineId, {
        quantity: req.body?.quantity,
      });
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: task!.id,
        action: 'update',
        summary: `Изменено количество услуги в задаче #${task!.id}`,
        details: buildAuditDetails({ before, after: task }),
      });
      return res.json({ task });
    } catch (error: any) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Строка задачи не найдена.' : 'Не удалось обновить услугу.',
        taskWriteErrorMessage
      );
    }
  });

  router.delete('/api/tasks/:id/services/:lineId', requireRight(db, 'tasks_edit'), (req: Request, res: Response) => {
    try {
      const before = requireVisibleTask(req, res);
      if (!before) return;
      const task = deleteTaskService(db, req.params.id, req.params.lineId);
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: task!.id,
        action: 'update',
        summary: `Удалена услуга из задачи #${task!.id}`,
        details: buildAuditDetails({ before, after: task }),
      });
      return res.json({ task });
    } catch (error: any) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Строка задачи не найдена.' : 'Не удалось удалить услугу.',
        taskWriteErrorMessage
      );
    }
  });

  router.post('/api/tasks/:id/discount', requireRight(db, 'tasks_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const before = requireVisibleTask(req, res);
      if (!before) return;
      const task = applyTaskDiscount(db, req.params.id, req.body || {});
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: task!.id,
        action: 'update',
        summary: `Изменена скидка в задаче #${task!.id}`,
        details: buildAuditDetails({ before, after: task }),
      });
      return res.json({ task });
    } catch (error: any) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Задача не найдена.' : 'Не удалось применить скидку.',
        taskWriteErrorMessage
      );
    }
  });

  router.post(
    '/api/tasks/:id/payments',
    requireRight(db, 'tasks_payment_create'),
    express.json(),
    (req: Request, res: Response) => {
      try {
        const before = requireVisibleTask(req, res);
        if (!before) return;
        const payment = createTaskPayment(db, before.id, {
          payment_type_id: req.body?.payment_type_id,
          amount: req.body?.amount,
          currency: req.body?.currency,
          note: req.body?.note,
          created_by_user_id: sessionUserId(req),
        });
        const task = visibleTask(req);
        auditAdminChange(db, req, {
          entityType: 'task',
          entityId: before.id,
          action: 'update',
          summary: `Принята оплата ${payment!.amount} ${payment!.currency} по задаче #${before.id}`,
          details: buildAuditDetails({ before, after: task }),
        });
        return res.status(201).json({ task });
      } catch (error: any) {
        return respondWriteError(
          res,
          error,
          error.message === 'NOT_FOUND' ? 'Задача не найдена.' : 'Не удалось принять оплату.',
          taskWriteErrorMessage
        );
      }
    }
  );

  router.delete(
    '/api/tasks/:id/payments/:paymentId',
    requireRight(db, 'tasks_payment_delete'),
    (req: Request, res: Response) => {
      try {
        const before = requireVisibleTask(req, res);
        if (!before) return;
        const payment = getTaskPayment(db, before.id, req.params.paymentId);
        if (!payment) return res.status(404).json({ message: 'Оплата не найдена.' });
        deleteTaskPayment(db, before.id, payment.id);
        const task = visibleTask(req);
        auditAdminChange(db, req, {
          entityType: 'task',
          entityId: before.id,
          action: 'update',
          summary: `Удалена оплата ${payment.amount} ${payment.currency} по задаче #${before.id}`,
          details: buildAuditDetails({ before, after: task }),
        });
        return res.json({ task });
      } catch (error: any) {
        return respondWriteError(
          res,
          error,
          error.message === 'NOT_FOUND' ? 'Оплата не найдена.' : 'Не удалось удалить оплату.',
          taskWriteErrorMessage
        );
      }
    }
  );

  router.post(
    '/api/tasks/:id/refunds',
    requireRight(db, 'tasks_edit'),
    express.json(),
    (req: Request, res: Response) => {
      try {
        const before = requireVisibleTask(req, res);
        if (!before) return;
        if (
          hasRefundPaymentInput(req.body) &&
          !actorHasPermission(db, getSessionActor(req), 'tasks_payment_create')
        ) {
          return res.status(403).json({ message: 'Нет доступа.' });
        }
        const result = refundTaskLine(
          db,
          before.id,
          {
            kind: req.body?.kind,
            line_id: req.body?.line_id,
            quantity: req.body?.quantity,
            payment_type_id: req.body?.payment_type_id,
            amount: req.body?.amount,
            currency: req.body?.currency,
            note: req.body?.note,
            created_by_user_id: sessionUserId(req),
          },
          taskViewer(req)
        );
        const { task, refund, payment, line_name, kind, quantity } = result;
        const kindLabel = kind === 'device' ? 'устройство' : 'услуга';
        const money = payment ? ` — ${payment.amount} ${payment.currency}` : '';
        auditAdminChange(db, req, {
          entityType: 'task',
          entityId: before.id,
          action: 'update',
          summary: `Возврат ${quantity}× ${kindLabel} «${line_name}»${money} по задаче #${before.id}`,
          details: buildAuditDetails({ before, after: task }),
        });
        return res.status(201).json({ task, refund });
      } catch (error: any) {
        return respondWriteError(
          res,
          error,
          error.message === 'NOT_FOUND' ? 'Задача не найдена.' : 'Не удалось оформить возврат.',
          taskWriteErrorMessage
        );
      }
    }
  );

}
