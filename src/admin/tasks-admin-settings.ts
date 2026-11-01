import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { requireRight, requireAnyRight } from './bot-admin-auth';
import { listLocations, getLocation, createLocation, updateLocation, deleteLocation } from '../db/locations';
import { listAccounts, getAccount, createAccount, updateAccount, deleteAccount } from '../db/accounts';
import { listPaymentTypes, getPaymentType, createPaymentType, updatePaymentType, deletePaymentType } from '../db/payment-types';
import { getUsdUzsRate, setUsdUzsRate } from '../db/money';
import { locationWriteErrorMessage, paymentTypeWriteErrorMessage, accountWriteErrorMessage, respondWriteError } from './tasks-admin-shared';

export function registerTaskSettingsRoutes(router: any, deps: { db: Db; auditAdminChange: (db: Db, req: Request, entry: Unchecked) => void; buildAuditDetails: (...args: any[]) => any }) {
  const { db, auditAdminChange, buildAuditDetails } = deps;
  router.get(
    '/api/settings/exchange-rate',
    requireAnyRight(db, ['settings_read', 'tasks_read', 'devices_read', 'services_read']),
    (_req: any, res: Response) => {
      try {
        return res.json({ usd_uzs_rate: getUsdUzsRate(db) });
      } catch (error: any) {
        console.error('Get exchange rate error:', error);
        return res.status(500).json({ message: 'Не удалось загрузить курс валют.' });
      }
    }
  );

  router.put('/api/settings/exchange-rate', requireRight(db, 'settings_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const before = getUsdUzsRate(db);
      const usd_uzs_rate = setUsdUzsRate(db, req.body?.usd_uzs_rate);
      auditAdminChange(db, req, {
        entityType: 'settings',
        entityId: 'usd_uzs_rate',
        action: 'update',
        summary: `Изменён курс валют: 1 USD = ${usd_uzs_rate} UZS`,
        details: buildAuditDetails({ before: { usd_uzs_rate: before }, after: { usd_uzs_rate } }),
      });
      return res.json({ usd_uzs_rate });
    } catch (error: any) {
      if (error.message === 'INVALID_EXCHANGE_RATE') {
        return res.status(400).json({ message: 'Курс должен быть числом больше 0.' });
      }
      console.error('Save exchange rate error:', error);
      return res.status(500).json({ message: 'Не удалось сохранить курс валют.' });
    }
  });

  router.get('/api/settings/locations', requireRight(db, 'settings_read'), (_req: any, res: Response) => {
    try {
      return res.json({ locations: listLocations(db) });
    } catch (error: any) {
      console.error('List locations error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить филиалы.' });
    }
  });

  router.post('/api/settings/locations', requireRight(db, 'settings_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const location = createLocation(db, {
        name: req.body?.name,
        address: req.body?.address,
        allowed_user_ids: req.body?.allowed_user_ids,
      });
      auditAdminChange(db, req, {
        entityType: 'location',
        entityId: location!.id,
        action: 'create',
        summary: `Создан филиал «${location!.name}»`,
        details: buildAuditDetails({ before: null, after: location }),
      });
      return res.status(201).json({ location });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось создать филиал.', locationWriteErrorMessage);
    }
  });

  router.put('/api/settings/locations/:id', requireRight(db, 'settings_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const before = getLocation(db, req.params.id);
      const location = updateLocation(db, req.params.id, {
        name: req.body?.name,
        address: req.body?.address,
        allowed_user_ids: req.body?.allowed_user_ids,
      });
      auditAdminChange(db, req, {
        entityType: 'location',
        entityId: location!.id,
        action: 'update',
        summary: `Изменён филиал #${location!.id}`,
        details: buildAuditDetails({ before, after: location }),
      });
      return res.json({ location });
    } catch (error: any) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Филиал не найден.' : 'Не удалось обновить филиал.',
        locationWriteErrorMessage
      );
    }
  });

  router.delete('/api/settings/locations/:id', requireRight(db, 'settings_edit'), (req: Request, res: Response) => {
    try {
      const before = getLocation(db, req.params.id);
      const deleted = deleteLocation(db, req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Филиал не найден.' });
      auditAdminChange(db, req, {
        entityType: 'location',
        entityId: before!.id,
        action: 'delete',
        summary: `Удалён филиал «${before!.name}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось удалить филиал.', locationWriteErrorMessage);
    }
  });

  router.get('/api/settings/accounts', requireRight(db, 'settings_read'), (_req: any, res: Response) => {
    try {
      return res.json({ accounts: listAccounts(db) });
    } catch (error: any) {
      console.error('List accounts error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить счета.' });
    }
  });

  router.post('/api/settings/accounts', requireRight(db, 'settings_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const account = createAccount(db, { name: req.body?.name, currency: req.body?.currency });
      auditAdminChange(db, req, {
        entityType: 'account',
        entityId: account!.id,
        action: 'create',
        summary: `Создан счёт «${account!.name}»`,
        details: buildAuditDetails({ before: null, after: account }),
      });
      return res.status(201).json({ account });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось создать счёт.', accountWriteErrorMessage);
    }
  });

  router.put('/api/settings/accounts/:id', requireRight(db, 'settings_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const before = getAccount(db, req.params.id);
      const account = updateAccount(db, req.params.id, {
        name: req.body?.name,
        currency: req.body?.currency,
      });
      auditAdminChange(db, req, {
        entityType: 'account',
        entityId: account!.id,
        action: 'update',
        summary: `Изменён счёт #${account!.id}`,
        details: buildAuditDetails({ before, after: account }),
      });
      return res.json({ account });
    } catch (error: any) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Счёт не найден.' : 'Не удалось обновить счёт.',
        accountWriteErrorMessage
      );
    }
  });

  router.delete('/api/settings/accounts/:id', requireRight(db, 'settings_edit'), (req: Request, res: Response) => {
    try {
      const before = getAccount(db, req.params.id);
      const deleted = deleteAccount(db, req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Счёт не найден.' });
      auditAdminChange(db, req, {
        entityType: 'account',
        entityId: before!.id,
        action: 'delete',
        summary: `Удалён счёт «${before!.name}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось удалить счёт.', accountWriteErrorMessage);
    }
  });

  router.get('/api/settings/payment-types', requireRight(db, 'settings_read'), (_req: any, res: Response) => {
    try {
      return res.json({ payment_types: listPaymentTypes(db) });
    } catch (error: any) {
      console.error('List payment types error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить типы оплаты.' });
    }
  });

  router.post('/api/settings/payment-types', requireRight(db, 'settings_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const paymentType = createPaymentType(db, { name: req.body?.name, account_id: req.body?.account_id });
      auditAdminChange(db, req, {
        entityType: 'payment_type',
        entityId: paymentType!.id,
        action: 'create',
        summary: `Создан тип оплаты «${paymentType!.name}»`,
        details: buildAuditDetails({ before: null, after: paymentType }),
      });
      return res.status(201).json({ payment_type: paymentType });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось создать тип оплаты.', paymentTypeWriteErrorMessage);
    }
  });

  router.put('/api/settings/payment-types/:id', requireRight(db, 'settings_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const before = getPaymentType(db, req.params.id);
      const paymentType = updatePaymentType(db, req.params.id, {
        name: req.body?.name,
        account_id: req.body?.account_id,
      });
      auditAdminChange(db, req, {
        entityType: 'payment_type',
        entityId: paymentType!.id,
        action: 'update',
        summary: `Изменён тип оплаты #${paymentType!.id}`,
        details: buildAuditDetails({ before, after: paymentType }),
      });
      return res.json({ payment_type: paymentType });
    } catch (error: any) {
      return respondWriteError(
        res,
        error,
        error.message === 'NOT_FOUND' ? 'Тип оплаты не найден.' : 'Не удалось обновить тип оплаты.',
        paymentTypeWriteErrorMessage
      );
    }
  });

  router.delete('/api/settings/payment-types/:id', requireRight(db, 'settings_edit'), (req: Request, res: Response) => {
    try {
      const before = getPaymentType(db, req.params.id);
      const deleted = deletePaymentType(db, req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Тип оплаты не найден.' });
      auditAdminChange(db, req, {
        entityType: 'payment_type',
        entityId: before!.id,
        action: 'delete',
        summary: `Удалён тип оплаты «${before!.name}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error: any) {
      return respondWriteError(res, error, 'Не удалось удалить тип оплаты.', paymentTypeWriteErrorMessage);
    }
  });

}
