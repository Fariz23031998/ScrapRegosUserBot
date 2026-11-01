import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { requireRight } from './bot-admin-auth';
import { getTask } from '../db/tasks';
import { listPrintTemplates, updatePrintTemplate } from '../db/print-templates';
import { getSerialByCode } from '../db/task-device-serials';
import { enqueueSerialLabelsForTask, enqueueTaskDocument, enqueueTestPrint } from '../print/print-dispatch';
import { getPrintHub } from '../print/print-gateway-ws';
import { getPrintSettingsPublic, savePrintSettings } from '../print/print-settings';
import { getRepairReturnSettingsPublic, saveRepairReturnSettings } from '../db/repair-return-settings';
import { taskWriteErrorMessage, respondWriteError } from './tasks-admin-shared';

export function registerTaskPrintRoutes(router: any, deps: { db: Db; taskViewer: (req: Request) => any; requireVisibleTask: (req: Request, res: Response) => any }) {
  const { db, taskViewer, requireVisibleTask } = deps;
  router.get('/api/settings/repair-returns', requireRight(db, 'settings_read'), (_req: any, res: Response) => {
    try {
      return res.json(getRepairReturnSettingsPublic(db));
    } catch (error: any) {
      console.error('Get repair return settings error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить настройки возврата устройств.' });
    }
  });

  router.put('/api/settings/repair-returns', requireRight(db, 'settings_edit'), express.json(), (req: Request, res: Response) => {
    try {
      return res.json(saveRepairReturnSettings(db, req.body || {}));
    } catch (error: any) {
      return respondWriteError(
        res,
        error,
        'Не удалось сохранить настройки возврата устройств.',
        taskWriteErrorMessage
      );
    }
  });

  router.get('/api/settings/print', requireRight(db, 'settings_read'), (_req: any, res: Response) => {
    try {
      const hub = getPrintHub();
      return res.json({
        ...getPrintSettingsPublic(db),
        connected: hub?.connectedCount() || 0,
        stations: hub?.listStations() || [],
      });
    } catch (error: any) {
      console.error('Get print settings error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить настройки печати.' });
    }
  });

  router.put('/api/settings/print', requireRight(db, 'settings_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const settings = savePrintSettings(db, req.body || {});
      const hub = getPrintHub();
      return res.json({
        ...settings,
        connected: hub?.connectedCount() || 0,
        stations: hub?.listStations() || [],
      });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось сохранить настройки печати.', taskWriteErrorMessage);
    }
  });

  router.post('/api/print/test', requireRight(db, 'settings_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const settings = getPrintSettingsPublic(db);
      if (!settings.token_configured) throw new Error('PRINT_GATEWAY_DISABLED');
      const job = enqueueTestPrint(db, {
        kind: req.body?.kind,
        location_id: req.body?.location_id,
        copies: req.body?.copies,
        printer_name: req.body?.printer_name,
        station_id: req.body?.station_id,
      });
      return res.status(201).json({ job, connected: getPrintHub()?.connectedCount() || 0 });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось отправить тестовую печать.', taskWriteErrorMessage);
    }
  });

  router.get('/api/print/templates', requireRight(db, 'settings_read'), (_req: any, res: Response) => {
    try {
      return res.json({ templates: listPrintTemplates(db) });
    } catch (error: any) {
      console.error('List print templates error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить шаблоны печати.' });
    }
  });

  router.put('/api/print/templates/:id', requireRight(db, 'settings_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const template = updatePrintTemplate(db, req.params.id, req.body || {});
      const hub = getPrintHub();
      if (hub) hub.pushTemplates();
      return res.json({ template });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось сохранить шаблон печати.', taskWriteErrorMessage);
    }
  });

  router.get('/api/print/serials/:code', requireRight(db, 'tasks_read'), (req: Request, res: Response) => {
    try {
      const serial = getSerialByCode(db, req.params.code);
      if (!serial) return res.status(404).json({ message: 'Серийный номер не найден.' });
      const task = getTask(db, serial.task_id, taskViewer(req));
      if (!task) return res.status(404).json({ message: 'Серийный номер не найден.' });
      return res.json({ serial, task });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось найти серийный номер.', taskWriteErrorMessage);
    }
  });

  router.post('/api/tasks/:id/print', requireRight(db, 'tasks_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const task = requireVisibleTask(req, res);
      if (!task) return;
      const kind = String(req.body?.kind || '').trim().toLowerCase();
      const printer = {
        printer_name: req.body?.printer_name,
        station_id: req.body?.station_id,
      };
      let jobs: any;
      if (kind === 'label') {
        jobs = enqueueSerialLabelsForTask(db, task, req.body?.serial_ids, printer);
      } else if (kind === 'receipt' || kind === 'invoice') {
        jobs = [enqueueTaskDocument(db, task, kind, printer)];
      } else {
        throw new Error('INVALID_PRINT_KIND');
      }
      return res.status(201).json({ jobs, connected: getPrintHub()?.connectedCount() || 0 });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось отправить на печать.', taskWriteErrorMessage);
    }
  });
}
