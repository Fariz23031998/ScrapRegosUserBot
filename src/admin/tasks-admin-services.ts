import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { requireRight, requireAnyRight } from './bot-admin-auth';
import { deleteCatalogImage } from '../db/catalog-images';
import { listCatalogCategories, getCatalogCategory, createCatalogCategory, updateCatalogCategory, deleteCatalogCategory, parseCategoryFilter } from '../db/catalog-categories';
import { listServices, getService, createService, updateService, deleteService } from '../db/services';
import { parsePaginationQuery, catalogMoneyFromBody, serviceWriteErrorMessage, categoryWriteErrorMessage, catalogImageErrorMessage, handleCatalogImageUpload, sendCatalogImageFile, uploadedImageFiles, saveUploadedCatalogImages, respondWriteError } from './tasks-admin-shared';

export function registerTaskServiceRoutes(router: any, deps: { db: Db; auditAdminChange: (db: Db, req: Request, entry: Unchecked) => void; buildAuditDetails: (...args: any[]) => any }) {
  const { db, auditAdminChange, buildAuditDetails } = deps;
  router.get('/api/services/categories', requireAnyRight(db, ['services_read', 'tasks_read']), (_req: any, res: Response) => {
    try {
      return res.json({ categories: listCatalogCategories(db, 'service') });
    } catch (error: any) {
      console.error('List service categories error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить категории.' });
    }
  });

  router.post('/api/services/categories', requireRight(db, 'services_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const category = createCatalogCategory(db, 'service', { name: req.body?.name });
      auditAdminChange(db, req, {
        entityType: 'service_category',
        entityId: category!.id,
        action: 'create',
        summary: `Создана категория услуг «${category!.name}»`,
        details: buildAuditDetails({ before: null, after: category }),
      });
      return res.status(201).json({ category });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось создать категорию.', categoryWriteErrorMessage);
    }
  });

  router.put('/api/services/categories/:id', requireRight(db, 'services_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const before = getCatalogCategory(db, 'service', req.params.id);
      const category = updateCatalogCategory(db, 'service', req.params.id, { name: req.body?.name });
      auditAdminChange(db, req, {
        entityType: 'service_category',
        entityId: category!.id,
        action: 'update',
        summary: `Изменена категория услуг #${category!.id}`,
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

  router.delete('/api/services/categories/:id', requireRight(db, 'services_edit'), (req: Request, res: Response) => {
    try {
      const before = getCatalogCategory(db, 'service', req.params.id);
      const deleted = deleteCatalogCategory(db, 'service', req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Категория не найдена.' });
      auditAdminChange(db, req, {
        entityType: 'service_category',
        entityId: before!.id,
        action: 'delete',
        summary: `Удалена категория услуг «${before!.name}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось удалить категорию.', categoryWriteErrorMessage);
    }
  });

  router.get('/api/services', requireAnyRight(db, ['services_read', 'tasks_read']), (req: Request, res: Response) => {
    try {
      const query = String(req.query.q || '').trim();
      const categoryId = parseCategoryFilter(req.query.category_id);
      let { page, limit, offset } = parsePaginationQuery(req);
      let result = listServices(db, { query, categoryId, offset, limit, sort: req.query.sort });
      const totalPages = Math.max(1, Math.ceil(Number(result!.total) / limit) || 1);
      if (page > totalPages) {
        page = totalPages;
        offset = (page - 1) * limit;
        result = listServices(db, { query, categoryId, offset, limit, sort: req.query.sort });
      }
      return res.json({
        services: result.services,
        total: result.total,
        page,
        limit,
      });
    } catch (error: any) {
      console.error('List services error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить услуги.' });
    }
  });

  router.post('/api/services', requireRight(db, 'services_create'), express.json(), (req: Request, res: Response) => {
    try {
      const service = createService(db, {
        name: req.body?.name,
        description: req.body?.description,
        category_id: req.body?.category_id,
        ...catalogMoneyFromBody(req.body),
      });
      auditAdminChange(db, req, {
        entityType: 'service',
        entityId: service!.id,
        action: 'create',
        summary: `Создана услуга «${service!.name}»`,
        details: buildAuditDetails({ before: null, after: service }),
      });
      return res.status(201).json({ service });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось создать услугу.', serviceWriteErrorMessage);
    }
  });

  router.put('/api/services/:id', requireRight(db, 'services_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const before = getService(db, req.params.id);
      const service = updateService(db, req.params.id, {
        name: req.body?.name,
        description: req.body?.description,
        category_id: req.body?.category_id,
        ...catalogMoneyFromBody(req.body),
      });
      auditAdminChange(db, req, {
        entityType: 'service',
        entityId: service!.id,
        action: 'update',
        summary: `Изменена услуга #${service!.id}`,
        details: buildAuditDetails({ before, after: service }),
      });
      return res.json({ service });
    } catch (error: any) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Услуга не найдена.' : 'Не удалось обновить услугу.',
        serviceWriteErrorMessage
      );
    }
  });

  router.delete('/api/services/:id', requireRight(db, 'services_delete'), (req: Request, res: Response) => {
    try {
      const before = getService(db, req.params.id);
      const deleted = deleteService(db, req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Услуга не найдена.' });
      auditAdminChange(db, req, {
        entityType: 'service',
        entityId: before!.id,
        action: 'delete',
        summary: `Удалена услуга «${before!.name}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось удалить услугу.', serviceWriteErrorMessage);
    }
  });

  router.get(
    '/api/services/:id/images/:imageId',
    requireAnyRight(db, ['services_read', 'tasks_read']),
    (req: Request, res: Response) => sendCatalogImageFile(res, db, 'service', req.params.id, req.params.imageId)
  );

  router.post(
    '/api/services/:id/images',
    requireAnyRight(db, ['services_edit', 'tasks_edit']),
    handleCatalogImageUpload,
    (req: Request, res: Response) => {
      try {
        const before = getService(db, req.params.id);
        if (!before) return res.status(404).json({ message: 'Услуга не найдена.' });
        saveUploadedCatalogImages(db, 'service', before.id, uploadedImageFiles(req));
        const service = getService(db, before.id);
        auditAdminChange(db, req, {
          entityType: 'service',
          entityId: service!.id,
          action: 'update',
          summary: `Добавлены фото услуги «${service!.name}»`,
          details: buildAuditDetails({ before, after: service }),
        });
        return res.status(201).json({ service });
      } catch (error: any) {
        return respondWriteError(
          res,
          error,
          error.message === 'NOT_FOUND' ? 'Услуга не найдена.' : 'Не удалось загрузить изображение.',
          (code?: any) => catalogImageErrorMessage(code) || serviceWriteErrorMessage(code)
        );
      }
    }
  );

  router.delete(
    '/api/services/:id/images/:imageId',
    requireAnyRight(db, ['services_edit', 'tasks_edit']),
    (req: Request, res: Response) => {
      try {
        const before = getService(db, req.params.id);
        if (!before) return res.status(404).json({ message: 'Услуга не найдена.' });
        deleteCatalogImage(db, 'service', before.id, req.params.imageId);
        const service = getService(db, before.id);
        auditAdminChange(db, req, {
          entityType: 'service',
          entityId: service!.id,
          action: 'update',
          summary: `Удалено фото услуги «${service!.name}»`,
          details: buildAuditDetails({ before, after: service }),
        });
        return res.json({ service });
      } catch (error: any) {
        return respondWriteError(
          res,
          error,
          error.message === 'NOT_FOUND' ? 'Изображение не найдено.' : 'Не удалось удалить изображение.',
          (code?: any) => catalogImageErrorMessage(code) || serviceWriteErrorMessage(code)
        );
      }
    }
  );

}
