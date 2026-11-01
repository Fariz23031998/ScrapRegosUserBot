import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import { getSessionActor, actorHasPermission } from './bot-admin-auth';
import { getBotUserById, getBotUserByTelegramId } from '../db/bot-users-db';
import { getLocationViewer } from '../db/locations';
import { getTask } from '../db/tasks';
import { registerTaskSettingsRoutes } from './tasks-admin-settings';
import { registerTaskDeviceRoutes } from './tasks-admin-devices';
import { registerTaskServiceRoutes } from './tasks-admin-services';
import { registerTaskCatalogRoutes } from './tasks-admin-tasks-catalog';
import { registerTaskReturnRoutes } from './tasks-admin-tasks-returns';
import { registerTaskLifecycleRoutes } from './tasks-admin-tasks-lifecycle';
import { registerTaskLineRoutes } from './tasks-admin-tasks-lines';
import { registerTaskWriteRoutes } from './tasks-admin-tasks-write';
import { registerTaskPrintRoutes } from './tasks-admin-tasks-print';

function registerTaskRoutes(router: any, db: Db, { auditAdminChange, buildAuditDetails }: Unchecked) {
  function taskViewer(req: Request) {
    return getLocationViewer(db, getSessionActor(req));
  }

  // Password-only admin sessions are not linked to a bot user, so payments they
  // take are stored without an author.
  function sessionUserId(req: Request) {
    const actor = getSessionActor(req);
    if (actor?.type === 'telegram') return getBotUserByTelegramId(db, actor.telegramId)?.id ?? null;
    if (actor?.type === 'user') return getBotUserById(db, actor.userId)?.id ?? null;
    return null;
  }

  function staffIdChanged(nextValue?: any, currentValue?: any) {
    if (nextValue === undefined) return false;
    const nextId = nextValue == null || nextValue === '' ? null : Number(nextValue);
    const currentId = currentValue == null ? null : Number(currentValue);
    if (nextId == null && currentId == null) return false;
    return nextId !== currentId;
  }

  function applyTaskStaffPermissions(req: Request, body: any, current: any = null) {
    const actor = getSessionActor(req);
    const canChangeManager = actorHasPermission(db, actor, 'tasks_manager');
    const canChangeTechnician = actorHasPermission(db, actor, 'tasks_technician');
    if (current) {
      if (staffIdChanged(body.manager_user_id, current.manager_user_id) && !canChangeManager) {
        return { error: 'Недостаточно прав для изменения менеджера задачи.' };
      }
      if (staffIdChanged(body.technician_user_id, current.technician_user_id) && !canChangeTechnician) {
        return { error: 'Недостаточно прав для изменения техника задачи.' };
      }
    }
    if (!canChangeManager) delete body.manager_user_id;
    if (!canChangeTechnician) delete body.technician_user_id;
    return { canChangeManager, canChangeTechnician };
  }

  function visibleTask(req: Request, id: any = req.params.id) {
    return getTask(db, id, taskViewer(req));
  }

  function requireVisibleTask(req: Request, res: Response) {
    const task = visibleTask(req);
    if (!task) {
      res.status(404).json({ message: 'Задача не найдена.' });
      return null;
    }
    return task;
  }

  const deps = {
    db,
    auditAdminChange,
    buildAuditDetails,
    taskViewer,
    sessionUserId,
    applyTaskStaffPermissions,
    visibleTask,
    requireVisibleTask,
  };

  registerTaskSettingsRoutes(router, deps);
  registerTaskDeviceRoutes(router, deps);
  registerTaskServiceRoutes(router, deps);
  registerTaskCatalogRoutes(router, deps);
  registerTaskReturnRoutes(router, deps);
  registerTaskLifecycleRoutes(router, deps);
  registerTaskLineRoutes(router, deps);
  registerTaskWriteRoutes(router, deps);
  registerTaskPrintRoutes(router, deps);
}

export { registerTaskRoutes };
