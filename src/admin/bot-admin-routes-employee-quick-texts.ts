import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import {
  createEmployeeQuickText,
  deleteEmployeeQuickText,
  listEmployeeQuickTexts,
  updateEmployeeQuickText,
  type EmployeeQuickTextKind,
} from '../db/employee-quick-texts';
import { requireAdminAuth } from './bot-admin-auth';
import { resolveSessionBotUser } from './bot-admin-shared';

function resolveOwnerUserId(db: Db, req: Request): number | null {
  const botUser = resolveSessionBotUser(db, req);
  const id = botUser?.id != null ? Number(botUser.id) : null;
  return Number.isFinite(id) && id != null && id > 0 ? id : null;
}

function mapError(error: unknown, res: Response) {
  const message = error instanceof Error ? error.message : '';
  if (message === 'INVALID_QUICK_TEXT_TITLE') {
    return res.status(400).json({ message: 'Заголовок слишком длинный (макс. 120 символов).' });
  }
  if (message === 'INVALID_QUICK_TEXT_BODY') {
    return res.status(400).json({ message: 'Текст обязателен и не длиннее 4000 символов.' });
  }
  return res.status(500).json({ message: 'Ошибка сохранения.' });
}

function registerKindRoutes(router: any, deps: { db: Db }, kind: EmployeeQuickTextKind, basePath: string) {
  const { db } = deps;

  router.get(basePath, requireAdminAuth, (req: Request, res: Response) => {
    const userId = resolveOwnerUserId(db, req);
    const items = listEmployeeQuickTexts(db, kind, userId);
    return res.json({ items });
  });

  router.post(basePath, requireAdminAuth, express.json(), (req: Request, res: Response) => {
    try {
      const userId = resolveOwnerUserId(db, req);
      const item = createEmployeeQuickText(db, kind, userId, {
        title: req.body?.title,
        body: req.body?.body,
      });
      return res.status(201).json({ item });
    } catch (error) {
      return mapError(error, res);
    }
  });

  router.patch(`${basePath}/:id`, requireAdminAuth, express.json(), (req: Request, res: Response) => {
    try {
      const userId = resolveOwnerUserId(db, req);
      const item = updateEmployeeQuickText(db, kind, req.params.id, userId, {
        title: req.body?.title,
        body: req.body?.body,
      });
      if (!item) return res.status(404).json({ message: 'Не найдено.' });
      return res.json({ item });
    } catch (error) {
      return mapError(error, res);
    }
  });

  router.delete(`${basePath}/:id`, requireAdminAuth, (req: Request, res: Response) => {
    const userId = resolveOwnerUserId(db, req);
    const ok = deleteEmployeeQuickText(db, kind, req.params.id, userId);
    if (!ok) return res.status(404).json({ message: 'Не найдено.' });
    return res.json({ ok: true });
  });
}

export function registerBotAdminEmployeeQuickTextRoutes(router: any, deps: { db: Db }) {
  registerKindRoutes(router, deps, 'ai_assist_prompt', '/api/me/ai-assist-prompts');
  registerKindRoutes(router, deps, 'chat_snippet', '/api/me/chat-snippets');
}
