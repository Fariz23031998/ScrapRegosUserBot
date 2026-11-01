import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { requireRight } from './bot-admin-auth';
import { listRepairDeviceReturns, createTaskDeviceReturn, deleteTaskDeviceReturn } from '../db/task-device-returns';
import { enqueueLabelJobs, uniqueLabelPrinterForLocation } from '../print/print-dispatch';
import { isRepairReturnRequireSerials } from '../db/repair-return-settings';
import { parsePaginationQuery, taskWriteErrorMessage, respondWriteError } from './tasks-admin-shared';

export function registerTaskReturnRoutes(router: any, deps: { db: Db; auditAdminChange: (db: Db, req: Request, entry: Unchecked) => void; buildAuditDetails: (...args: any[]) => any; taskViewer: (req: Request) => any; sessionUserId: (req: Request) => any }) {
  const { db, auditAdminChange, buildAuditDetails, taskViewer, sessionUserId } = deps;
  router.get('/api/repair-returns', requireRight(db, 'tasks_read'), (req: Request, res: Response) => {
    try {
      const query = String(req.query.q || '').trim();
      const status = String(req.query.status || 'pending').trim() || 'pending';
      const locationId = String(req.query.location_id || '').trim();
      const viewer = taskViewer(req);
      let { page, limit, offset } = parsePaginationQuery(req);
      let result = listRepairDeviceReturns(db, {
        query,
        status,
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
        result = listRepairDeviceReturns(db, {
          query,
          status,
          locationId: locationId || undefined,
          viewer,
          offset,
          limit,
          sort: req.query.sort,
        });
      }
      return res.json({
        items: result.items,
        total: result.total,
        page,
        limit,
        require_serials: isRepairReturnRequireSerials(db),
      });
    } catch (error: any) {
      return respondWriteError(
        res,
        error,
        'Не удалось загрузить возвраты устройств.',
        taskWriteErrorMessage
      );
    }
  });

  router.post('/api/repair-returns', requireRight(db, 'tasks_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const result = createTaskDeviceReturn(
        db,
        {
          device_line_id: req.body?.device_line_id,
          quantity: req.body?.quantity,
          serial_ids: req.body?.serial_ids,
          serial_codes: req.body?.serial_codes,
          note: req.body?.note,
          created_by_user_id: sessionUserId(req),
        },
        taskViewer(req)
      );
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: result.task?.id,
        action: 'update',
        summary: `Возврат устройства «${result.item?.device_name || result.item?.device_line_id}» по задаче #${result.task?.id}`,
        details: buildAuditDetails({ after: result.task }),
      });
      try {
        if (result.serials?.length) {
          const printer = uniqueLabelPrinterForLocation(result.task?.location_id);
          if (printer) {
            enqueueLabelJobs(db, {
              task: result.task,
              serials: result.serials,
              deviceName: result.item?.device_name,
              printer_name: printer.name,
              station_id: printer.station_id,
            });
          }
        }
      } catch (printError: any) {
        console.error('Repair return print failed:', printError);
      }
      return res.status(201).json({ item: result.item, task: result.task });
    } catch (error: any) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Устройство не найдено.' : 'Не удалось оформить возврат устройства.',
        taskWriteErrorMessage
      );
    }
  });

  router.delete('/api/repair-returns/:id', requireRight(db, 'tasks_edit'), (req: Request, res: Response) => {
    try {
      const result = deleteTaskDeviceReturn(db, req.params.id, taskViewer(req));
      auditAdminChange(db, req, {
        entityType: 'task',
        entityId: result.task?.id,
        action: 'update',
        summary: `Отменён возврат устройства по задаче #${result.task?.id}`,
        details: buildAuditDetails({ after: result.task }),
      });
      return res.json({ ok: true, task: result.task });
    } catch (error: any) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Возврат устройства не найден.' : 'Не удалось отменить возврат устройства.',
        taskWriteErrorMessage
      );
    }
  });

}
