import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { buildAuditDetails } from '../db/admin-audit-logs';
import { getSessionActor, requireRight } from './bot-admin-auth';
import { listKnowledgeArticles, getKnowledgeArticle, createKnowledgeArticle, updateKnowledgeArticle, deleteKnowledgeArticle, setKnowledgeArticleLocked, setKnowledgeArticleConfirmed, listKnowledgeCategories, getKnowledgeCategory, createKnowledgeCategory, updateKnowledgeCategory, deleteKnowledgeCategory, appendKnowledgeArticleImage, stripKnowledgeArticleImage } from '../db/knowledge-articles';
import { MAX_IMAGES_PER_ARTICLE, addKnowledgeImage, deleteKnowledgeImage, getKnowledgeImage, resolveKnowledgeImageFile } from '../db/knowledge-images';
import { knowledgeImageErrorMessage, handleKnowledgeImageUpload, parsePaginationQuery, auditAdminChange, resolveKnowledgeActorUserId } from './bot-admin-shared';

export function registerBotAdminKnowledgeRoutes(router: any, deps: { db: Db }) {
  const { db } = deps;
  function resolveKnowledgeCreator(req: Request) {
    const userId = resolveKnowledgeActorUserId(db, req);
    if (userId != null) return String(userId);
    const actor = getSessionActor(req);
    if (actor?.type === 'password') return 'admin';
    return null;
  }

  function knowledgeArticleLockMessage() {
    return 'Статья заблокирована. Изменение и удаление недоступны.';
  }

  function parseCategoryIdFilter(value?: any) {
    if (value == null || value === '') return undefined;
    const raw = String(value).trim().toLowerCase();
    if (raw === 'none' || raw === 'uncategorized' || raw === '0') return null;
    const id = Number(value);
    if (!Number.isFinite(id) || id <= 0) return undefined;
    return id;
  }

  function articleFieldsFromBody(body: any = {}) {
    const input: Unchecked = {
      title: body.title,
      body: body.body,
      tags: body.tags,
    };
    if (Object.prototype.hasOwnProperty.call(body, 'category_id')) {
      input.category_id = body.category_id;
    }
    return input;
  }

  function respondKnowledgeWriteError(res: Response, error: Error, fallbackMessage?: any) {
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({ message: 'Статья не найдена.' });
    }
    if (error.message === 'ARTICLE_LOCKED') {
      return res.status(409).json({ message: knowledgeArticleLockMessage() });
    }
    if (
      [
        'INVALID_ARTICLE_TITLE',
        'INVALID_ARTICLE_BODY',
        'INVALID_ARTICLE_TAGS',
        'INVALID_ARTICLE_CATEGORY',
      ].includes(error.message)
    ) {
      return res.status(400).json({
        message:
          error.message === 'INVALID_ARTICLE_CATEGORY'
            ? 'Некорректная категория статьи.'
            : 'Некорректные данные статьи.',
      });
    }
    const imageMessage = knowledgeImageErrorMessage(error.message);
    if (imageMessage) {
      return res.status(400).json({ message: imageMessage });
    }
    console.error(fallbackMessage, error);
    return res.status(500).json({ message: fallbackMessage });
  }

  function respondKnowledgeCategoryWriteError(res: Response, error: Error, fallbackMessage?: any) {
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({ message: 'Категория не найдена.' });
    }
    if (['INVALID_CATEGORY_NAME', 'INVALID_CATEGORY_TAGS'].includes(error.message)) {
      return res.status(400).json({ message: 'Некорректные данные категории.' });
    }
    console.error(fallbackMessage, error);
    return res.status(500).json({ message: fallbackMessage });
  }

  router.get('/api/knowledge/categories', requireRight(db, 'knowledge_read'), (_req: any, res: Response) => {
    try {
      return res.json({ categories: listKnowledgeCategories(db) });
    } catch (error: any) {
      console.error('List knowledge categories error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить категории.' });
    }
  });

  router.post('/api/knowledge/categories', requireRight(db, 'knowledge_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const category = createKnowledgeCategory(db, { name: req.body?.name, tags: req.body?.tags });
      auditAdminChange(db, req, {
        entityType: 'knowledge_category',
        entityId: category!.id,
        action: 'create',
        summary: `Создана категория «${category!.name}»`,
        details: buildAuditDetails({ before: null, after: category }),
      });
      return res.status(201).json({ category });
    } catch (error: any) {
      return respondKnowledgeCategoryWriteError(res, error, 'Не удалось создать категорию.');
    }
  });

  router.put('/api/knowledge/categories/:id', requireRight(db, 'knowledge_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const before = getKnowledgeCategory(db, req.params.id);
      const category = updateKnowledgeCategory(db, req.params.id, {
        name: req.body?.name,
        tags: req.body?.tags,
      });
      auditAdminChange(db, req, {
        entityType: 'knowledge_category',
        entityId: category!.id,
        action: 'update',
        summary: `Изменена категория #${category!.id}`,
        details: buildAuditDetails({ before, after: category }),
      });
      return res.json({ category });
    } catch (error: any) {
      return respondKnowledgeCategoryWriteError(res, error, 'Не удалось обновить категорию.');
    }
  });

  router.delete('/api/knowledge/categories/:id', requireRight(db, 'knowledge_edit'), (req: Request, res: Response) => {
    try {
      const before = getKnowledgeCategory(db, req.params.id);
      const deleted = deleteKnowledgeCategory(db, req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Категория не найдена.' });
      auditAdminChange(db, req, {
        entityType: 'knowledge_category',
        entityId: before!.id,
        action: 'delete',
        summary: `Удалена категория #${before!.id}`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error: any) {
      return respondKnowledgeCategoryWriteError(res, error, 'Не удалось удалить категорию.');
    }
  });

  router.get('/api/knowledge/articles', requireRight(db, 'knowledge_read'), (req: Request, res: Response) => {
    try {
      const query = String(req.query.q || '').trim();
      const categoryId = parseCategoryIdFilter(req.query.category_id);
      let { page, limit, offset } = parsePaginationQuery(req);
      let result = listKnowledgeArticles(db, { query, offset, limit, categoryId });
      const totalPages = Math.max(1, Math.ceil(result.total / limit) || 1);
      if (page > totalPages) {
        page = totalPages;
        offset = (page - 1) * limit;
        result = listKnowledgeArticles(db, { query, offset, limit, categoryId });
      }
      return res.json({
        articles: result.articles,
        total: result.total,
        page,
        limit,
      });
    } catch (error: any) {
      console.error('List knowledge articles error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить базу знаний.' });
    }
  });

  router.get('/api/knowledge/articles/:id', requireRight(db, 'knowledge_read'), (req: Request, res: Response) => {
    const article = getKnowledgeArticle(db, req.params.id);
    if (!article) return res.status(404).json({ message: 'Статья не найдена.' });
    return res.json({ article });
  });

  router.get(
    '/api/knowledge/articles/:id/images/:imageId',
    requireRight(db, 'knowledge_read'),
    (req: Request, res: Response) => {
      const row = getKnowledgeImage(db, req.params.id, req.params.imageId);
      if (!row) return res.status(404).json({ message: 'Изображение не найдено.' });
      const file = resolveKnowledgeImageFile(row);
      if (!file) return res.status(404).json({ message: 'Изображение не найдено.' });
      res.setHeader('Content-Type', file.mime);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.sendFile(file.filePath);
    }
  );

  router.post(
    '/api/knowledge/articles/:id/images',
    requireRight(db, 'knowledge_edit'),
    handleKnowledgeImageUpload,
    (req: Request, res: Response) => {
      try {
        const before = getKnowledgeArticle(db, req.params.id);
        if (!before) return res.status(404).json({ message: 'Статья не найдена.' });
        if (before.locked) throw new Error('ARTICLE_LOCKED');
        const files = Array.isArray(req.files) ? req.files : [];
        if (!files.length) throw new Error('INVALID_IMAGE_TYPE');
        const remaining = MAX_IMAGES_PER_ARTICLE - ((before as { images?: any[] }).images || []).length;
        if (remaining <= 0 || files.length > remaining) throw new Error('IMAGE_LIMIT_REACHED');
        let article = before;
        for (const file of files) {
          const image = addKnowledgeImage(db, before.id, {
            buffer: file.buffer,
            originalName: file.originalname,
          });
          article = appendKnowledgeArticleImage(db, article, image, file.originalname, {
            updatedBy: resolveKnowledgeActorUserId(db, req),
          })!;
        }
        auditAdminChange(db, req, {
          entityType: 'knowledge_article',
          entityId: article.id,
          action: 'update',
          summary: `Добавлены скриншоты статьи #${article.id}`,
          details: buildAuditDetails({ before, after: article }),
        });
        return res.status(201).json({ article });
      } catch (error: any) {
        return respondKnowledgeWriteError(res, error, 'Не удалось загрузить изображение.');
      }
    }
  );

  router.delete(
    '/api/knowledge/articles/:id/images/:imageId',
    requireRight(db, 'knowledge_edit'),
    (req: Request, res: Response) => {
      try {
        const before = getKnowledgeArticle(db, req.params.id);
        if (!before) return res.status(404).json({ message: 'Статья не найдена.' });
        if (before.locked) throw new Error('ARTICLE_LOCKED');
        const image = deleteKnowledgeImage(db, before.id, req.params.imageId);
        const article = stripKnowledgeArticleImage(db, before, image, {
          updatedBy: resolveKnowledgeActorUserId(db, req),
        });
        auditAdminChange(db, req, {
          entityType: 'knowledge_article',
          entityId: article!.id,
          action: 'update',
          summary: `Удалён скриншот статьи #${article!.id}`,
          details: buildAuditDetails({ before, after: article }),
        });
        return res.json({ article });
      } catch (error: any) {
        if (error.message === 'NOT_FOUND') {
          return res.status(404).json({ message: 'Изображение не найдено.' });
        }
        return respondKnowledgeWriteError(res, error, 'Не удалось удалить изображение.');
      }
    }
  );

  router.post('/api/knowledge/articles', requireRight(db, 'knowledge_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const article = createKnowledgeArticle(
        db,
        articleFieldsFromBody(req.body),
        {
          updatedBy: resolveKnowledgeActorUserId(db, req),
          creator: resolveKnowledgeCreator(req),
        }
      );
      auditAdminChange(db, req, {
        entityType: 'knowledge_article',
        entityId: article!.id,
        action: 'create',
        summary: `Создана статья «${article!.title}»`,
        details: buildAuditDetails({ before: null, after: article }),
      });
      return res.status(201).json({ article });
    } catch (error: any) {
      if (
        [
          'INVALID_ARTICLE_TITLE',
          'INVALID_ARTICLE_BODY',
          'INVALID_ARTICLE_TAGS',
          'INVALID_ARTICLE_CATEGORY',
        ].includes(error.message)
      ) {
        return res.status(400).json({
          message:
            error.message === 'INVALID_ARTICLE_CATEGORY'
              ? 'Некорректная категория статьи.'
              : 'Некорректные данные статьи.',
        });
      }
      console.error('Create knowledge article error:', error);
      return res.status(500).json({ message: 'Не удалось создать статью.' });
    }
  });

  router.put('/api/knowledge/articles/:id', requireRight(db, 'knowledge_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const before = getKnowledgeArticle(db, req.params.id);
      const article = updateKnowledgeArticle(
        db,
        req.params.id,
        articleFieldsFromBody(req.body),
        { updatedBy: resolveKnowledgeActorUserId(db, req) }
      );
      auditAdminChange(db, req, {
        entityType: 'knowledge_article',
        entityId: article!.id,
        action: 'update',
        summary: `Изменена статья #${article!.id}`,
        details: buildAuditDetails({ before, after: article }),
      });
      return res.json({ article });
    } catch (error: any) {
      return respondKnowledgeWriteError(res, error, 'Не удалось обновить статью.');
    }
  });

  router.post('/api/knowledge/articles/:id/lock', requireRight(db, 'knowledge_lock'), (req: Request, res: Response) => {
    try {
      const before = getKnowledgeArticle(db, req.params.id);
      const article = setKnowledgeArticleLocked(db, req.params.id, true, {
        updatedBy: resolveKnowledgeActorUserId(db, req),
      });
      auditAdminChange(db, req, {
        entityType: 'knowledge_article',
        entityId: article!.id,
        action: 'lock',
        summary: `Заблокирована статья #${article!.id}`,
        details: buildAuditDetails({ before, after: article }),
      });
      return res.json({ article });
    } catch (error: any) {
      return respondKnowledgeWriteError(res, error, 'Не удалось заблокировать статью.');
    }
  });

  router.post('/api/knowledge/articles/:id/unlock', requireRight(db, 'knowledge_unlock'), (req: Request, res: Response) => {
    try {
      const before = getKnowledgeArticle(db, req.params.id);
      const article = setKnowledgeArticleLocked(db, req.params.id, false, {
        updatedBy: resolveKnowledgeActorUserId(db, req),
      });
      auditAdminChange(db, req, {
        entityType: 'knowledge_article',
        entityId: article!.id,
        action: 'unlock',
        summary: `Разблокирована статья #${article!.id}`,
        details: buildAuditDetails({ before, after: article }),
      });
      return res.json({ article });
    } catch (error: any) {
      return respondKnowledgeWriteError(res, error, 'Не удалось разблокировать статью.');
    }
  });

  router.post('/api/knowledge/articles/:id/confirm', requireRight(db, 'knowledge_confirm'), (req: Request, res: Response) => {
    try {
      const before = getKnowledgeArticle(db, req.params.id);
      const article = setKnowledgeArticleConfirmed(db, req.params.id, true, {
        updatedBy: resolveKnowledgeActorUserId(db, req),
      });
      auditAdminChange(db, req, {
        entityType: 'knowledge_article',
        entityId: article!.id,
        action: 'confirm',
        summary: `Подтверждена статья #${article!.id}`,
        details: buildAuditDetails({ before, after: article }),
      });
      return res.json({ article });
    } catch (error: any) {
      return respondKnowledgeWriteError(res, error, 'Не удалось подтвердить статью.');
    }
  });

  router.post('/api/knowledge/articles/:id/unconfirm', requireRight(db, 'knowledge_confirm'), (req: Request, res: Response) => {
    try {
      const before = getKnowledgeArticle(db, req.params.id);
      const article = setKnowledgeArticleConfirmed(db, req.params.id, false, {
        updatedBy: resolveKnowledgeActorUserId(db, req),
      });
      auditAdminChange(db, req, {
        entityType: 'knowledge_article',
        entityId: article!.id,
        action: 'unconfirm',
        summary: `Снято подтверждение со статьи #${article!.id}`,
        details: buildAuditDetails({ before, after: article }),
      });
      return res.json({ article });
    } catch (error: any) {
      return respondKnowledgeWriteError(res, error, 'Не удалось снять подтверждение статьи.');
    }
  });

  router.delete('/api/knowledge/articles/:id', requireRight(db, 'knowledge_edit'), (req: Request, res: Response) => {
    try {
      const before = getKnowledgeArticle(db, req.params.id);
      const deleted = deleteKnowledgeArticle(db, req.params.id);
      if (!deleted) return res.status(404).json({ message: 'Статья не найдена.' });
      auditAdminChange(db, req, {
        entityType: 'knowledge_article',
        entityId: before!.id,
        action: 'delete',
        summary: `Удалена статья #${before!.id}`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error: any) {
      return respondKnowledgeWriteError(res, error, 'Не удалось удалить статью.');
    }
  });

}
