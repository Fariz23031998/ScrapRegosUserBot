import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { buildAuditDetails } from '../db/admin-audit-logs';
import { requireRight, requireAnyRight } from './bot-admin-auth';
import { listTechnicalSupportPrices, updateTechnicalSupportPrices, listTechnicalSupportSubscriptions, createManualTechnicalSupportSubscription, deactivateTechnicalSupportSubscription, updateTechnicalSupportSubscriptionEndsAt, deleteTechnicalSupportSubscription, getTechnicalSupportSubscriptionById, mapSubscriptionRow } from '../db/technical-support';
import { getServicePricesCatalog, replaceServicePricesCatalog } from '../db/service-prices';
import { snapshotPricesForAudit, snapshotCatalogForAudit, parsePaginationQuery, auditAdminChange } from './bot-admin-shared';

export function registerBotAdminSupportRoutes(router: any, deps: { db: Db }) {
  const { db } = deps;
  router.get('/api/technical-support/prices', requireRight(db, 'technical_support_read'), (_req: any, res: Response) => {
    res.json({ prices: listTechnicalSupportPrices(db) });
  });

  router.put(
    '/api/technical-support/prices',
    requireRight(db, 'technical_support_edit'),
    express.json(),
    (req: Request, res: Response) => {
    try {
      const beforePrices = snapshotPricesForAudit(listTechnicalSupportPrices(db));
      const prices = updateTechnicalSupportPrices(db, req.body?.prices || req.body || {});
      const afterPrices = snapshotPricesForAudit(prices);
      auditAdminChange(db, req, {
        entityType: 'technical_support_price',
        entityId: null,
        action: 'update',
        summary: 'Обновлены цены технической поддержки',
        details: buildAuditDetails({
          before: Object.fromEntries(
            (beforePrices || []).map((row?: any) => [String(row.months), row.amount])
          ),
          after: Object.fromEntries(
            (afterPrices || []).map((row?: any) => [String(row.months), row.amount])
          ),
        }),
      });
      return res.json({ prices });
    } catch (error: any) {
      if (error.message === 'INVALID_AMOUNT') {
        return res.status(400).json({ message: 'Сумма должна быть целым числом ≥ 0.' });
      }
      if (error.message === 'NO_PRICES') {
        return res.status(400).json({ message: 'Укажите хотя бы одну цену для обновления.' });
      }
      console.error('Update technical support prices error:', error);
      return res.status(500).json({ message: 'Не удалось сохранить цены.' });
    }
  });

  router.get(
    '/api/technical-support/subscriptions',
    requireRight(db, 'technical_support_read'),
    (req: Request, res: Response) => {
    const query = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    let { page, limit, offset } = parsePaginationQuery(req);
    let result = listTechnicalSupportSubscriptions(db, {
      query,
      status,
      offset,
      limit,
      sort: req.query.sort,
    });
    const totalPages = Math.max(1, Math.ceil(Number(result!.total) / limit) || 1);
    if (page > totalPages) {
      page = totalPages;
      offset = (page - 1) * limit;
      result = listTechnicalSupportSubscriptions(db, {
        query,
        status,
        offset,
        limit,
        sort: req.query.sort,
      });
    }
    res.json({
      subscriptions: result.items,
      total: result.total,
      page,
      limit,
    });
  });

  router.post(
    '/api/technical-support/subscriptions',
    requireRight(db, 'technical_support_create'),
    express.json(),
    (req: Request, res: Response) => {
      try {
        const result = createManualTechnicalSupportSubscription(db, {
          phone: req.body?.phone,
          months: req.body?.months,
          amount: req.body?.amount,
          ends_at: req.body?.ends_at,
        });
        auditAdminChange(db, req, {
          entityType: 'technical_support_subscription',
          entityId: result.subscription?.id,
          action: 'create',
          summary: `Создана подписка ТП для ${result.subscription?.phone || req.body?.phone}`,
          details: buildAuditDetails({
            before: null,
            after: mapSubscriptionRow(result.subscription),
          }),
        });
        return res.status(201).json({
          subscription: mapSubscriptionRow(result.subscription),
        });
      } catch (error: any) {
        if (error.message === 'INVALID_PHONE') {
          return res.status(400).json({ message: 'Укажите корректный телефон.' });
        }
        if (error.message === 'INVALID_MONTHS') {
          return res.status(400).json({ message: 'Срок должен быть 1, 3, 6 или 12 месяцев.' });
        }
        if (error.message === 'INVALID_AMOUNT') {
          return res.status(400).json({ message: 'Сумма должна быть целым числом ≥ 0.' });
        }
        if (error.message === 'INVALID_ENDS_AT') {
          return res
            .status(400)
            .json({ message: 'Укажите корректную дату окончания в будущем.' });
        }
        console.error('Create technical support subscription error:', error);
        return res.status(500).json({ message: 'Не удалось создать подписку.' });
      }
    }
  );

  router.post(
    '/api/technical-support/subscriptions/:id/deactivate',
    requireRight(db, 'technical_support_edit'),
    (req: Request, res: Response) => {
      try {
        const before = getTechnicalSupportSubscriptionById(db, req.params.id);
        const result = deactivateTechnicalSupportSubscription(db, req.params.id);
        auditAdminChange(db, req, {
          entityType: 'technical_support_subscription',
          entityId: req.params.id,
          action: 'deactivate',
          summary: `Деактивирована подписка ТП #${req.params.id}`,
          details: buildAuditDetails({
            before: before ? mapSubscriptionRow(before) : null,
            after: mapSubscriptionRow(result.subscription),
          }),
        });
        return res.json({
          changed: result.changed,
          reason: result.reason || null,
          subscription: mapSubscriptionRow(result.subscription),
        });
      } catch (error: any) {
        if (error.message === 'NOT_FOUND') {
          return res.status(404).json({ message: 'Подписка не найдена.' });
        }
        console.error('Deactivate technical support subscription error:', error);
        return res.status(500).json({ message: 'Не удалось деактивировать подписку.' });
      }
    }
  );

  router.put(
    '/api/technical-support/subscriptions/:id',
    requireRight(db, 'technical_support_edit'),
    express.json(),
    (req: Request, res: Response) => {
      try {
        const before = getTechnicalSupportSubscriptionById(db, req.params.id);
        const result = updateTechnicalSupportSubscriptionEndsAt(db, req.params.id, req.body?.ends_at);
        auditAdminChange(db, req, {
          entityType: 'technical_support_subscription',
          entityId: req.params.id,
          action: 'update',
          summary: `Обновлена дата окончания подписки ТП #${req.params.id}`,
          details: buildAuditDetails({
            before: before
              ? {
                  ends_at: mapSubscriptionRow(before)!.ends_at ?? null,
                  phone: before.phone ?? null,
                }
              : null,
            after: {
              ends_at: result.subscription?.ends_at ?? null,
              phone: result.subscription?.phone ?? before?.phone ?? null,
            },
          }),
        });
        return res.json({
          subscription: mapSubscriptionRow(result.subscription),
        });
      } catch (error: any) {
        if (error.message === 'NOT_FOUND') {
          return res.status(404).json({ message: 'Подписка не найдена.' });
        }
        if (error.message === 'INVALID_ENDS_AT') {
          return res.status(400).json({ message: 'Укажите корректную дату окончания.' });
        }
        console.error('Update technical support subscription error:', error);
        return res.status(500).json({ message: 'Не удалось обновить подписку.' });
      }
    }
  );

  router.delete(
    '/api/technical-support/subscriptions/:id',
    requireRight(db, 'technical_support_delete'),
    (req: Request, res: Response) => {
      try {
        const before = getTechnicalSupportSubscriptionById(db, req.params.id);
        const result = deleteTechnicalSupportSubscription(db, req.params.id);
        auditAdminChange(db, req, {
          entityType: 'technical_support_subscription',
          entityId: req.params.id,
          action: 'delete',
          summary: `Удалена подписка ТП #${req.params.id}`,
          details: buildAuditDetails({
            before: before ? mapSubscriptionRow(before) : null,
            after: null,
          }),
        });
        return res.json({ deleted: result.deleted, id: result.id });
      } catch (error: any) {
        if (error.message === 'NOT_FOUND') {
          return res.status(404).json({ message: 'Подписка не найдена.' });
        }
        console.error('Delete technical support subscription error:', error);
        return res.status(500).json({ message: 'Не удалось удалить подписку.' });
      }
    }
  );

  router.get('/api/prices', requireRight(db, 'prices_read'), (_req: any, res: Response) => {
    try {
      return res.json(getServicePricesCatalog(db));
    } catch (error: any) {
      console.error('Load service prices error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить прайс.' });
    }
  });

  router.put(
    '/api/prices',
    requireAnyRight(db, ['prices_edit', 'prices_create', 'prices_delete']),
    express.json({ limit: '1mb' }),
    (req: Request, res: Response) => {
    try {
      const beforeCatalog = snapshotCatalogForAudit(getServicePricesCatalog(db));
      const catalog = replaceServicePricesCatalog(db, req.body || {});
      const afterCatalog = snapshotCatalogForAudit(catalog);
      auditAdminChange(db, req, {
        entityType: 'service_price',
        entityId: null,
        action: 'update',
        summary: `Обновлён прайс (${catalog?.categories?.length ?? 0} кат.)`,
        details: buildAuditDetails({
          before: beforeCatalog,
          after: afterCatalog,
        }),
      });
      return res.json(catalog);
    } catch (error: any) {
      const messages = {
        INVALID_TEXT: 'Проверьте обязательные текстовые поля и их длину.',
        INVALID_PRICE: 'Значение цены слишком длинное.',
        NO_CATEGORIES: 'Добавьте хотя бы одну категорию.',
        NO_ITEMS: 'В каждой категории должна быть хотя бы одна услуга.',
        TOO_MANY_CATEGORIES: 'Слишком много категорий.',
        TOO_MANY_ITEMS: 'Слишком много услуг в категории.',
      };
      if ((messages as Record<string, string>)[error.message]) {
        return res.status(400).json({ message: (messages as Record<string, string>)[error.message] });
      }
      console.error('Update service prices error:', error);
      return res.status(500).json({ message: 'Не удалось сохранить прайс.' });
    }
  });

}
