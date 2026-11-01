import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import { listOrderLogs, mapOrderLogRow } from '../db/order-logs';
import { listAdminAuditLogs, mapAdminAuditLogRow } from '../db/admin-audit-logs';
import { requireRight } from './bot-admin-auth';
import { parsePaginationQuery } from './bot-admin-shared';

export function registerBotAdminLogRoutes(router: any, deps: { db: Db }) {
  const { db } = deps;
  router.get('/api/order-logs', requireRight(db, 'order_logs_read'), (req: Request, res: Response) => {
    const query = String(req.query.q || '').trim();
    let { page, limit, offset } = parsePaginationQuery(req);
    const sort = req.query.sort;
    let result = listOrderLogs(db, { query: query || undefined, offset, limit, sort });
    const totalPages = Math.max(1, Math.ceil(result.total / limit) || 1);
    if (page > totalPages) {
      page = totalPages;
      offset = (page - 1) * limit;
      result = listOrderLogs(db, { query: query || undefined, offset, limit, sort });
    }
    res.json({
      logs: result.logs.map(mapOrderLogRow),
      total: result.total,
      page,
      limit,
    });
  });

  router.get('/api/logs', requireRight(db, 'logs_read'), (req: Request, res: Response) => {
    const query = String(req.query.q || '').trim();
    let { page, limit, offset } = parsePaginationQuery(req);
    let result = listAdminAuditLogs(db, { query: query || undefined, offset, limit, sort: req.query.sort });
    const totalPages = Math.max(1, Math.ceil(result.total / limit) || 1);
    if (page > totalPages) {
      page = totalPages;
      offset = (page - 1) * limit;
      result = listAdminAuditLogs(db, { query: query || undefined, offset, limit, sort: req.query.sort });
    }
    res.json({
      logs: result.logs.map(mapAdminAuditLogRow),
      total: result.total,
      page,
      limit,
    });
  });

}
