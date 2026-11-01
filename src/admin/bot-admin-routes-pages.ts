import type { Db } from '../types/db';
import type { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import express from 'express';
import { isAuthenticated, getSessionActor, getSessionPermissions, requireAdminAuth, requireRight } from './bot-admin-auth';
import { payloadTooLargeHandler } from '../http/body-parser';
import { sendPublicFile, sendBotAdminReactUiIndex, isBotAdminSpaPath } from './bot-admin-shared';

export function registerBotAdminPageRoutes(router: any, deps: { db: Db; publicDir: string; reactUiDistDir: string; reactUiReady: boolean }) {
  const { db, publicDir, reactUiDistDir, reactUiReady } = deps;
  if (reactUiReady) {
    // SPA client routes — auth/permissions are enforced by the React app and APIs.
    const spaPagePaths = [
      '/users',
      '/orders',
      '/order-logs',
      '/logs',
      '/tickets',
      '/tickets/:id',
      '/technical-support',
      '/prices',
      '/knowledge',
      '/customer-agent',
      '/test-agents',
      '/prompts',
      '/settings',
    ];
    for (const spaPath of spaPagePaths) {
      router.get(spaPath, (_req: any, res: Response) => sendBotAdminReactUiIndex(res));
    }
  } else {
    router.get('/order-logs', requireRight(db, 'order_logs_read'), (_req: any, res: Response) => {
      return sendPublicFile(res, publicDir, 'order-logs.html');
    });

    router.get('/logs', requireRight(db, 'logs_read'), (_req: any, res: Response) => {
      return sendPublicFile(res, publicDir, 'logs.html');
    });

    router.get('/orders', requireRight(db, 'orders_read'), (_req: any, res: Response) => {
      return sendPublicFile(res, publicDir, 'orders.html');
    });

    router.get('/tickets/:id', requireRight(db, 'tickets_read'), (_req: any, res: Response) => {
      return sendPublicFile(res, publicDir, 'ticket-detail.html');
    });

    router.get('/tickets', requireRight(db, 'tickets_read'), (_req: any, res: Response) => {
      return sendPublicFile(res, publicDir, 'tickets.html');
    });

    router.get('/technical-support', requireRight(db, 'technical_support_read'), (_req: any, res: Response) => {
      return sendPublicFile(res, publicDir, 'technical-support.html');
    });

    router.get('/prices', requireRight(db, 'prices_read'), (_req: any, res: Response) => {
      return sendPublicFile(res, publicDir, 'prices.html');
    });

    router.get('/settings', requireRight(db, 'settings_read'), (_req: any, res: Response) => {
      return sendPublicFile(res, publicDir, 'settings.html');
    });
  }

  router.get('/', (req: Request, res: Response) => {
    // Without the trailing slash the browser resolves page-relative asset URLs
    // against the site root, so redirect to the canonical directory form.
    if (!req.originalUrl.split('?')[0].endsWith('/')) {
      const query = req.originalUrl.slice(req.originalUrl.indexOf('?') + 1);
      const suffix = req.originalUrl.includes('?') ? `?${query}` : '';
      return res.redirect(`${req.baseUrl}/${suffix}`);
    }
    // React SPA enforces auth client-side (and via APIs). Do not 302 to /login —
    // Telegram Mini Apps break on that redirect (initData + cookies).
    if (reactUiReady) {
      return sendBotAdminReactUiIndex(res);
    }
    if (!isAuthenticated(req)) {
      return res.redirect('/bot-admin/login');
    }
    const actor = getSessionActor(req);
    const permissions = getSessionPermissions(db, actor);
    if (permissions.tickets_read) return res.redirect('/bot-admin/tickets');
    if (permissions.orders_read) return res.redirect('/bot-admin/orders');
    if (permissions.order_logs_read) return res.redirect('/bot-admin/order-logs');
    if (permissions.logs_read) return res.redirect('/bot-admin/logs');
    if (permissions.technical_support_read) return res.redirect('/bot-admin/technical-support');
    if (permissions.prices_read) return res.redirect('/bot-admin/prices');
    if (permissions.settings_read) return res.redirect('/bot-admin/settings');
    if (permissions.users_read) {
      return sendPublicFile(res, publicDir, 'index.html');
    }
    return res.status(403).send('Нет доступа. Недостаточно прав для этого раздела.');
  });

  if (reactUiReady && fs.existsSync(reactUiDistDir)) {
    router.use(express.static(reactUiDistDir, { index: false }));
    router.get('*', (req: Request, res: Response, next: NextFunction) => {
      if (!isBotAdminSpaPath(req.path)) return next();
      return sendBotAdminReactUiIndex(res);
    });
  } else {
    router.use(requireAdminAuth, express.static(publicDir, { index: false }));
  }

  router.use(payloadTooLargeHandler);
}
