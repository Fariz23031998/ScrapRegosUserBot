import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { buildAuditDetails } from '../db/admin-audit-logs';
import { requireRight } from './bot-admin-auth';
import { listPromptTypes, getPrompt, createPrompt, updatePrompt, setActivePrompt, deletePrompt } from '../db/ai-prompts';
import { listPromptVariables, getPromptVariable, createPromptVariable, updatePromptVariable, deletePromptVariable, testVariableSource } from '../db/ai-prompt-variables';
import { listToolDescriptions, getToolDescription, saveToolDescription, resetToolDescription } from '../db/ai-tool-descriptions';
import { auditAdminChange, resolveKnowledgeActorUserId } from './bot-admin-shared';

export function registerBotAdminAiPromptRoutes(router: any, deps: { db: Db }) {
  const { db } = deps;
  function respondPromptWriteError(res: Response, error: Error, fallbackMessage?: any) {
    if (error.message === 'PROMPT_NOT_FOUND' || error.message === 'INVALID_PROMPT_SLUG') {
      return res.status(404).json({ message: 'Промпт не найден.' });
    }
    if (error.message === 'INVALID_PROMPT_BODY' || error.message === 'INVALID_PROMPT_NAME') {
      return res.status(400).json({ message: 'Некорректные данные промпта.' });
    }
    console.error(fallbackMessage, error);
    return res.status(500).json({ message: fallbackMessage });
  }

  router.get('/api/ai/prompts', requireRight(db, 'settings_read'), (_req: any, res: Response) => {
    try {
      return res.json({ types: listPromptTypes(db) });
    } catch (error: any) {
      console.error('List AI prompts error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить промпты.' });
    }
  });

  router.post('/api/ai/prompts', requireRight(db, 'settings_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const prompt = createPrompt(
        db,
        { type: req.body?.type, name: req.body?.name, body: req.body?.body },
        { updatedBy: resolveKnowledgeActorUserId(db, req) }
      );
      auditAdminChange(db, req, {
        entityType: 'ai_prompt',
        entityId: prompt.id,
        action: 'create',
        summary: `Создан промпт «${prompt.name}»`,
        details: buildAuditDetails({ before: null, after: prompt }),
      });
      return res.status(201).json({ prompt });
    } catch (error: any) {
      return respondPromptWriteError(res, error, 'Не удалось создать промпт.');
    }
  });

  router.put('/api/ai/prompts/active', requireRight(db, 'settings_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const prompt = setActivePrompt(db, req.body?.type, req.body?.prompt_id);
      auditAdminChange(db, req, {
        entityType: 'ai_prompt',
        entityId: prompt.id ?? `${prompt.type}:default`,
        action: 'update',
        summary: prompt.is_default
          ? `Включён промпт по умолчанию «${prompt.type}»`
          : `Включён промпт «${prompt.name}»`,
        details: buildAuditDetails({ after: prompt }),
      });
      return res.json({ prompt });
    } catch (error: any) {
      return respondPromptWriteError(res, error, 'Не удалось включить промпт.');
    }
  });

  router.put('/api/ai/prompts/:id', requireRight(db, 'settings_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const before = getPrompt(db, req.params.id);
      const prompt = updatePrompt(
        db,
        req.params.id,
        { name: req.body?.name, body: req.body?.body },
        { updatedBy: resolveKnowledgeActorUserId(db, req) }
      );
      auditAdminChange(db, req, {
        entityType: 'ai_prompt',
        entityId: prompt.id,
        action: 'update',
        summary: `Изменён промпт «${prompt.name}»`,
        details: buildAuditDetails({ before, after: prompt }),
      });
      return res.json({ prompt });
    } catch (error: any) {
      return respondPromptWriteError(res, error, 'Не удалось сохранить промпт.');
    }
  });

  router.delete('/api/ai/prompts/:id', requireRight(db, 'settings_edit'), (req: Request, res: Response) => {
    try {
      const before = getPrompt(db, req.params.id);
      const prompt = deletePrompt(db, req.params.id);
      auditAdminChange(db, req, {
        entityType: 'ai_prompt',
        entityId: before.id,
        action: 'delete',
        summary: `Удалён промпт «${before.name}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true, prompt });
    } catch (error: any) {
      return respondPromptWriteError(res, error, 'Не удалось удалить промпт.');
    }
  });

  function respondToolDescriptionWriteError(res: Response, error: Error, fallbackMessage?: any) {
    if (error.message === 'UNKNOWN_TOOL') {
      return res.status(404).json({ message: 'Инструмент не найден.' });
    }
    if (error.message === 'INVALID_TOOL_DESCRIPTION') {
      return res.status(400).json({ message: 'Некорректное описание инструмента.' });
    }
    console.error(fallbackMessage, error);
    return res.status(500).json({ message: fallbackMessage });
  }

  router.get('/api/ai/tool-descriptions', requireRight(db, 'settings_read'), (_req: any, res: Response) => {
    try {
      return res.json({ tools: listToolDescriptions(db) });
    } catch (error: any) {
      console.error('List AI tool descriptions error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить описания инструментов.' });
    }
  });

  router.put('/api/ai/tool-descriptions/:name', requireRight(db, 'settings_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const before = getToolDescription(db, req.params.name);
      const tool = saveToolDescription(db, req.params.name, req.body?.body, {
        updatedBy: resolveKnowledgeActorUserId(db, req),
      });
      auditAdminChange(db, req, {
        entityType: 'ai_tool_description',
        entityId: tool.name,
        action: 'update',
        summary: `Изменено описание инструмента «${tool.title}»`,
        details: buildAuditDetails({ before, after: tool }),
      });
      return res.json({ tool });
    } catch (error: any) {
      return respondToolDescriptionWriteError(res, error, 'Не удалось сохранить описание инструмента.');
    }
  });

  router.delete('/api/ai/tool-descriptions/:name', requireRight(db, 'settings_edit'), (req: Request, res: Response) => {
    try {
      const before = getToolDescription(db, req.params.name);
      const tool = resetToolDescription(db, req.params.name);
      auditAdminChange(db, req, {
        entityType: 'ai_tool_description',
        entityId: before.name,
        action: 'delete',
        summary: `Сброшено описание инструмента «${before.title}»`,
        details: buildAuditDetails({ before, after: tool }),
      });
      return res.json({ ok: true, tool });
    } catch (error: any) {
      return respondToolDescriptionWriteError(res, error, 'Не удалось сбросить описание инструмента.');
    }
  });

  function respondPromptVariableWriteError(res: Response, error: Error, fallbackMessage?: any) {
    if (error.message === 'VARIABLE_NOT_FOUND') {
      return res.status(404).json({ message: 'Переменная не найдена.' });
    }
    if (error.message === 'INVALID_VARIABLE_KEY') {
      return res.status(400).json({ message: 'Ключ переменной: латиница, цифры и _, начинается с буквы.' });
    }
    if (error.message === 'INVALID_VARIABLE_NAME') {
      return res.status(400).json({ message: 'Некорректное название переменной.' });
    }
    if (error.message === 'INVALID_VARIABLE_SOURCE') {
      return res.status(400).json({ message: 'Введите тело JavaScript-функции.' });
    }
    if (error.message === 'VARIABLE_KEY_TAKEN') {
      return res.status(409).json({ message: 'Переменная с таким ключом уже есть.' });
    }
    console.error(fallbackMessage, error);
    return res.status(500).json({ message: fallbackMessage });
  }

  router.get('/api/ai/prompt-variables', requireRight(db, 'settings_read'), (_req: any, res: Response) => {
    try {
      return res.json({ variables: listPromptVariables(db) });
    } catch (error: any) {
      console.error('List AI prompt variables error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить переменные.' });
    }
  });

  router.post('/api/ai/prompt-variables/test', requireRight(db, 'prompt_variables_create'), express.json(), (req: Request, res: Response) => {
    try {
      const source = req.body?.source != null ? String(req.body.source) : '';
      return res.json(testVariableSource(db, source, req.body?.context || {}));
    } catch (error: any) {
      return respondPromptVariableWriteError(res, error, 'Не удалось выполнить переменную.');
    }
  });

  router.post('/api/ai/prompt-variables/:id/test', requireRight(db, 'prompt_variables_create'), express.json(), (req: Request, res: Response) => {
    try {
      const variable = getPromptVariable(db, req.params.id);
      const source = req.body?.source != null ? String(req.body.source) : variable.source;
      return res.json(testVariableSource(db, source, req.body?.context || {}));
    } catch (error: any) {
      return respondPromptVariableWriteError(res, error, 'Не удалось выполнить переменную.');
    }
  });

  router.post('/api/ai/prompt-variables', requireRight(db, 'prompt_variables_create'), express.json(), (req: Request, res: Response) => {
    try {
      const variable = createPromptVariable(
        db,
        { key: req.body?.key, name: req.body?.name, source: req.body?.source },
        { updatedBy: resolveKnowledgeActorUserId(db, req) }
      );
      auditAdminChange(db, req, {
        entityType: 'ai_prompt_variable',
        entityId: variable.id,
        action: 'create',
        summary: `Создана переменная промпта «${variable.key}»`,
        details: buildAuditDetails({ before: null, after: variable }),
      });
      return res.status(201).json({ variable });
    } catch (error: any) {
      return respondPromptVariableWriteError(res, error, 'Не удалось создать переменную.');
    }
  });

  router.put('/api/ai/prompt-variables/:id', requireRight(db, 'prompt_variables_create'), express.json(), (req: Request, res: Response) => {
    try {
      const before = getPromptVariable(db, req.params.id);
      const variable = updatePromptVariable(
        db,
        req.params.id,
        { key: req.body?.key, name: req.body?.name, source: req.body?.source },
        { updatedBy: resolveKnowledgeActorUserId(db, req) }
      );
      auditAdminChange(db, req, {
        entityType: 'ai_prompt_variable',
        entityId: variable.id,
        action: 'update',
        summary: `Изменена переменная промпта «${variable.key}»`,
        details: buildAuditDetails({ before, after: variable }),
      });
      return res.json({ variable });
    } catch (error: any) {
      return respondPromptVariableWriteError(res, error, 'Не удалось сохранить переменную.');
    }
  });

  router.delete('/api/ai/prompt-variables/:id', requireRight(db, 'prompt_variables_create'), (req: Request, res: Response) => {
    try {
      const before = getPromptVariable(db, req.params.id);
      const result = deletePromptVariable(db, req.params.id);
      auditAdminChange(db, req, {
        entityType: 'ai_prompt_variable',
        entityId: before.id,
        action: 'delete',
        summary: `Удалена переменная промпта «${before.key}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true, variable: result.variable });
    } catch (error: any) {
      return respondPromptVariableWriteError(res, error, 'Не удалось удалить переменную.');
    }
  });

}
