import type { Db } from '../types/db';
import type { Response } from 'express';
import { createKnowledgeMcpRouter } from '../mcp/knowledge-mcp';
import { createOpsMcpRouter } from '../mcp/ops-mcp';
import { sendPublicFile } from './bot-admin-shared';

export function registerBotAdminLoginRoutes(router: any, deps: { db: Db; publicDir: string; reactUiReady: boolean; sendBotAdminPage: (res: Response, legacyFilename?: any) => any }) {
  const { db, publicDir, reactUiReady, sendBotAdminPage } = deps;
  router.get('/login', (_req: any, res: Response) => sendBotAdminPage(res, 'login.html'));
  router.get('/login.css', (_req: any, res: Response) => {
    if (reactUiReady) return res.status(404).end();
    return sendPublicFile(res, publicDir, 'login.css');
  });
  router.get('/login.js', (_req: any, res: Response) => {
    if (reactUiReady) return res.status(404).end();
    return sendPublicFile(res, publicDir, 'login.js');
  });

  router.use(createKnowledgeMcpRouter(db));
  router.use(createOpsMcpRouter(db));
}
