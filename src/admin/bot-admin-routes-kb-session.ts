import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { getSessionActor, actorHasPermission, requireRight } from './bot-admin-auth';
import { respondAgentChat } from '../http/agent-chat-sse';
import { runKbAgent } from '../ai/kb-agent';
import { CHAT_MESSAGE_JSON_LIMIT, parseChatUploadFiles } from '../ai/chat-uploads';
import { getOrCreateKbSession, listKbSessionMessages, clearKbSessionHistory } from '../db/knowledge-articles';
import { isAiCredentialError, aiCredentialErrorMessage, mapAgentChatError, resolveKnowledgeActorUserId } from './bot-admin-shared';

export function registerBotAdminKbSessionRoutes(router: any, deps: { db: Db }) {
  const { db } = deps;
  router.get('/api/ai/kb-session', requireRight(db, 'knowledge_read'), (req: Request, res: Response) => {
    try {
      const session = getOrCreateKbSession(db, { userId: resolveKnowledgeActorUserId(db, req) });
      return res.json({
        session_id: session!.id,
        messages: listKbSessionMessages(db, session!.id),
      });
    } catch (error: any) {
      console.error('Load KB session error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить чат базы знаний.' });
    }
  });

  router.post('/api/ai/kb-session', requireRight(db, 'knowledge_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const userId = resolveKnowledgeActorUserId(db, req);
      const session = Boolean(req.body?.reset)
        ? clearKbSessionHistory(db, { sessionId: req.body?.session_id, userId })
        : getOrCreateKbSession(db, { sessionId: req.body?.session_id, userId });
      return res.json({
        session_id: session!.id,
        messages: listKbSessionMessages(db, session!.id),
      });
    } catch (error: any) {
      if (error.message === 'FORBIDDEN') {
        return res.status(403).json({ message: 'Нет доступа к этому чату.' });
      }
      console.error('Update KB session error:', error);
      return res.status(500).json({ message: 'Не удалось обновить чат базы знаний.' });
    }
  });

  router.post(
    '/api/ai/kb-chat',
    requireRight(db, 'knowledge_edit'),
    express.json({ limit: CHAT_MESSAGE_JSON_LIMIT }),
    async (req: Request, res: Response) => {
    try {
      let files: any;
      try {
        files = parseChatUploadFiles(req.body?.files);
      } catch (parseError: any) {
        return res.status(parseError.status || 400).json({
          message: parseError.message || 'Некорректный файл.',
        });
      }
      const message = String(req.body?.message || '').trim();
      if (!message && files.length === 0) {
        return res.status(400).json({ message: 'Введите текст сообщения или прикрепите файл.' });
      }
      return respondAgentChat(
        req,
        res,
        ({ onDelta }: Unchecked) =>
          runKbAgent({
            db,
            userId: resolveKnowledgeActorUserId(db, req),
            sessionId: req.body?.session_id,
            message,
            files,
            canWrite: actorHasPermission(db, getSessionActor(req), 'knowledge_edit'),
            onDelta,
          }),
        { mapError: (error: Error) => mapAgentChatError(error, 'Не удалось получить ответ агента.') }
      );
    } catch (error: any) {
      if (error.message === 'EMPTY_MESSAGE') {
        return res.status(400).json({ message: 'Введите текст сообщения или прикрепите файл.' });
      }
      if (isAiCredentialError(error)) {
        return res.status(503).json({ message: aiCredentialErrorMessage(error) });
      }
      console.error('KB chat error:', error);
      return res.status(500).json({ message: 'Не удалось получить ответ агента.' });
    }
  });

}
