import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { requireRight, requireAnyRight } from './bot-admin-auth';
import { deleteCatalogImage } from '../db/catalog-images';
import { listCatalogCategories, getCatalogCategory, createCatalogCategory, updateCatalogCategory, deleteCatalogCategory, parseCategoryFilter } from '../db/catalog-categories';
import { listDevices, getDevice, createDevice, updateDevice, deleteDevice } from '../db/devices';
import { parsePaginationQuery, catalogMoneyFromBody, deviceWriteErrorMessage, categoryWriteErrorMessage, catalogImageErrorMessage, handleCatalogImageUpload, sendCatalogImageFile, uploadedImageFiles, saveUploadedCatalogImages, respondWriteError } from './tasks-admin-shared';

export function registerTaskDeviceRoutes(router: any, deps: { db: Db; auditAdminChange: (db: Db, req: Request, entry: Unchecked) => void; buildAuditDetails: (...args: any[]) => any }) {
  const { db, auditAdminChange, buildAuditDetails } = deps;
  router.get('/api/devices/categories', requireAnyRight(db, ['devices_read', 'tasks_read']), (_req: any, res: Response) => {
    try {
      return res.json({ categories: listCatalogCategories(db, 'device') });
    } catch (error: any) {
      console.error('List device categories error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить категории.' });
    }
  });

  router.post('/api/devices/categories', requireRight(db, 'devices_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const category = createCatalogCategory(db, 'device', { name: req.body?.name });
      auditAdminChange(db, req, {
        entityType: 'device_category',
        entityId: category!.id,
        action: 'create',
        summary: `Создана категория устройств «${category!.name}»`,
        details: buildAuditDetails({ before: null, after: category }),
      });
      return res.status(201).json({ category });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось создать категорию.', categoryWriteErrorMessage);
    }
  });

  router.put('/api/devices/categories/:id', requireRight(db, 'devices_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const before = getCatalogCategory(db, 'device', req.params.id);
      const category = updateCatalogCategory(db, 'device', req.params.id, { name: req.body?.name });
      auditAdminChange(db, req, {
        entityType: 'device_category',
        entityId: category!.id,
        action: 'update',
        summary: `Изменена категория устройств #${category!.id}`,
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

  router.delete('/api/devices/categories/:id', requireRight(db, 'devices_edit'), (req: Request, res: Response) => {
    try {
      const before = getCatalogCategory(db, 'device', req.params.id);
      const deleted = deleteCatalogCategory(db, 'device', req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Категория не найдена.' });
      auditAdminChange(db, req, {
        entityType: 'device_category',
        entityId: before!.id,
        action: 'delete',
        summary: `Удалена категория устройств «${before!.name}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось удалить категорию.', categoryWriteErrorMessage);
    }
  });

  router.get('/api/devices', requireAnyRight(db, ['devices_read', 'tasks_read']), (req: Request, res: Response) => {
    try {
      const query = String(req.query.q || '').trim();
      const categoryId = parseCategoryFilter(req.query.category_id);
      let { page, limit, offset } = parsePaginationQuery(req);
      let result = listDevices(db, { query, categoryId, offset, limit, sort: req.query.sort });
      const totalPages = Math.max(1, Math.ceil(Number(result!.total) / limit) || 1);
      if (page > totalPages) {
        page = totalPages;
        offset = (page - 1) * limit;
        result = listDevices(db, { query, categoryId, offset, limit, sort: req.query.sort });
      }
      return res.json({
        devices: result.devices,
        total: result.total,
        page,
        limit,
      });
    } catch (error: any) {
      console.error('List devices error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить устройства.' });
    }
  });

  router.post('/api/devices', requireRight(db, 'devices_create'), express.json(), (req: Request, res: Response) => {
    try {
      const device = createDevice(db, {
        name: req.body?.name,
        description: req.body?.description,
        category_id: req.body?.category_id,
        ...catalogMoneyFromBody(req.body),
      });
      auditAdminChange(db, req, {
        entityType: 'device',
        entityId: device!.id,
        action: 'create',
        summary: `Создано устройство «${device!.name}»`,
        details: buildAuditDetails({ before: null, after: device }),
      });
      return res.status(201).json({ device });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось создать устройство.', deviceWriteErrorMessage);
    }
  });

  router.put('/api/devices/:id', requireRight(db, 'devices_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const before = getDevice(db, req.params.id);
      const device = updateDevice(db, req.params.id, {
        name: req.body?.name,
        description: req.body?.description,
        category_id: req.body?.category_id,
        ...catalogMoneyFromBody(req.body),
      });
      auditAdminChange(db, req, {
        entityType: 'device',
        entityId: device!.id,
        action: 'update',
        summary: `Изменено устройство #${device!.id}`,
        details: buildAuditDetails({ before, after: device }),
      });
      return res.json({ device });
    } catch (error: any) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Устройство не найдено.' : 'Не удалось обновить устройство.',
        deviceWriteErrorMessage
      );
    }
  });

  router.delete('/api/devices/:id', requireRight(db, 'devices_delete'), (req: Request, res: Response) => {
    try {
      const before = getDevice(db, req.params.id);
      const deleted = deleteDevice(db, req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Устройство не найдено.' });
      auditAdminChange(db, req, {
        entityType: 'device',
        entityId: before!.id,
        action: 'delete',
        summary: `Удалено устройство «${before!.name}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось удалить устройство.', deviceWriteErrorMessage);
    }
  });

  router.get(
    '/api/devices/:id/images/:imageId',
    requireAnyRight(db, ['devices_read', 'tasks_read']),
    (req: Request, res: Response) => sendCatalogImageFile(res, db, 'device', req.params.id, req.params.imageId)
  );

  router.post(
    '/api/devices/:id/images',
    requireAnyRight(db, ['devices_edit', 'tasks_edit']),
    handleCatalogImageUpload,
    (req: Request, res: Response) => {
      try {
        const before = getDevice(db, req.params.id);
        if (!before) return res.status(404).json({ message: 'Устройство не найдено.' });
        saveUploadedCatalogImages(db, 'device', before.id, uploadedImageFiles(req));
        const device = getDevice(db, before.id);
        auditAdminChange(db, req, {
          entityType: 'device',
          entityId: device!.id,
          action: 'update',
          summary: `Добавлены фото устройства «${device!.name}»`,
          details: buildAuditDetails({ before, after: device }),
        });
        return res.status(201).json({ device });
      } catch (error: any) {
        return respondWriteError(
          res,
          error,
          error.message === 'NOT_FOUND' ? 'Устройство не найдено.' : 'Не удалось загрузить изображение.',
          (code?: any) => catalogImageErrorMessage(code) || deviceWriteErrorMessage(code)
        );
      }
    }
  );

  router.delete(
    '/api/devices/:id/images/:imageId',
    requireAnyRight(db, ['devices_edit', 'tasks_edit']),
    (req: Request, res: Response) => {
      try {
        const before = getDevice(db, req.params.id);
        if (!before) return res.status(404).json({ message: 'Устройство не найдено.' });
        deleteCatalogImage(db, 'device', before.id, req.params.imageId);
        const device = getDevice(db, before.id);
        auditAdminChange(db, req, {
          entityType: 'device',
          entityId: device!.id,
          action: 'update',
          summary: `Удалено фото устройства «${device!.name}»`,
          details: buildAuditDetails({ before, after: device }),
        });
        return res.json({ device });
      } catch (error: any) {
        return respondWriteError(
          res,
          error,
          error.message === 'NOT_FOUND' ? 'Изображение не найдено.' : 'Не удалось удалить изображение.',
          (code?: any) => catalogImageErrorMessage(code) || deviceWriteErrorMessage(code)
        );
      }
    }
  );

}
