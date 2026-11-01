import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { getSessionActor, getSessionPermissions, actorHasPermission, actorHasAnyPermission, requireRight, requireAnyRight } from './bot-admin-auth';
import { RegosCrmError } from '../integrations/regos-crm';
import { respondAgentChat } from '../http/agent-chat-sse';
import { runOpsAgent, previewOpsAgentPrompt } from '../ai/ops-agent';
import { loadCustomerTestSession, runCustomerTestAgent } from '../ai/customer-test-agent';
import { loadEmployeeTestSession, runEmployeeTestAgent } from '../ai/employee-test-agent';
import { listCustomerTestSessions, deleteCustomerTestSession, clearCustomerTestSessions } from '../db/customer-agent-sessions';
import { CHAT_MESSAGE_JSON_LIMIT, parseChatUploadFiles } from '../ai/chat-uploads';
import { getOrCreateOpsSession, listOpsSessionMessages, clearOpsSessionHistory } from '../db/ops-agent-sessions';
import { getLocationViewer } from '../db/locations';
import { isAiCredentialError, aiCredentialErrorMessage, mapAgentChatError, resolveKnowledgeActorUserId } from './bot-admin-shared';

export function registerBotAdminOpsRoutes(router: any, deps: { db: Db }) {
  const { db } = deps;
  const OPS_READ_RIGHTS = ['tasks_read', 'devices_read', 'services_read'];
  const OPS_WRITE_RIGHTS = [
    'tasks_create',
    'tasks_edit',
    'tasks_delete',
    'tasks_post',
    'tasks_unpost',
    'tasks_payment_create',
    'tasks_payment_delete',
    'devices_create',
    'devices_edit',
    'devices_delete',
    'services_create',
    'services_edit',
    'services_delete',
  ];

  router.get('/api/ai/ops-session', requireAnyRight(db, OPS_READ_RIGHTS), (req: Request, res: Response) => {
    try {
      const session = getOrCreateOpsSession(db, { userId: resolveKnowledgeActorUserId(db, req) });
      return res.json({
        session_id: session!.id,
        messages: listOpsSessionMessages(db, session!.id),
      });
    } catch (error: any) {
      console.error('Load ops session error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить чат агента задач.' });
    }
  });

  router.post('/api/ai/ops-session', requireAnyRight(db, OPS_READ_RIGHTS), express.json(), (req: Request, res: Response) => {
    try {
      const userId = resolveKnowledgeActorUserId(db, req);
      const session = Boolean(req.body?.reset)
        ? clearOpsSessionHistory(db, { sessionId: req.body?.session_id, userId })
        : getOrCreateOpsSession(db, { sessionId: req.body?.session_id, userId });
      return res.json({
        session_id: session!.id,
        messages: listOpsSessionMessages(db, session!.id),
      });
    } catch (error: any) {
      if (error.message === 'FORBIDDEN') {
        return res.status(403).json({ message: 'Нет доступа к этому чату.' });
      }
      console.error('Update ops session error:', error);
      return res.status(500).json({ message: 'Не удалось обновить чат агента задач.' });
    }
  });

  router.get(
    '/api/ai/ops-prompt',
    requireRight(db, 'tickets_ai_prompt'),
    requireAnyRight(db, OPS_READ_RIGHTS),
    (req: Request, res: Response) => {
      try {
        const actor = getSessionActor(req);
        const preview = previewOpsAgentPrompt({
          db,
          userId: resolveKnowledgeActorUserId(db, req),
          sessionId: req.query.session_id,
          write: actorHasAnyPermission(db, actor, OPS_WRITE_RIGHTS),
          viewer: getLocationViewer(db, actor),
          permissions: getSessionPermissions(db, actor),
        });
        return res.json(preview);
      } catch (error: any) {
        if (error.message === 'FORBIDDEN') {
          return res.status(403).json({ message: 'Нет доступа к этому чату.' });
        }
        console.error('Get ops AI prompt error:', error);
        return res.status(500).json({ message: 'Не удалось загрузить промпт ИИ.' });
      }
    }
  );

  router.post(
    '/api/ai/ops-chat',
    requireAnyRight(db, OPS_READ_RIGHTS),
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
      const actor = getSessionActor(req);
      return respondAgentChat(
        req,
        res,
        ({ onDelta }: Unchecked) =>
          runOpsAgent({
            db,
            userId: resolveKnowledgeActorUserId(db, req),
            sessionId: req.body?.session_id,
            message,
            files,
            write: actorHasAnyPermission(db, actor, OPS_WRITE_RIGHTS),
            viewer: getLocationViewer(db, actor),
            permissions: getSessionPermissions(db, actor),
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
      console.error('Ops chat error:', error);
      return res.status(500).json({ message: 'Не удалось получить ответ агента.' });
    }
  });

  function parseOptionalTestTicketId(value?: any) {
    if (value === undefined) return undefined;
    if (value == null || value === '') return null;
    const id = Number(value);
    return Number.isFinite(id) && id > 0 ? id : null;
  }

  function parseOptionalTestPhone(value?: any) {
    if (value === undefined) return undefined;
    return String(value || '').trim();
  }

  function sendCustomerTestError(res: Response, error: Error) {
    if (error.message === 'EMPTY_MESSAGE') {
      return res.status(400).json({ message: 'Введите текст сообщения или прикрепите файл.' });
    }
    if (error.message === 'TICKET_NOT_FOUND') {
      return res.status(404).json({ message: 'Тикет не найден.' });
    }
    if (error.message === 'SESSION_NOT_FOUND') {
      return res.status(404).json({ message: 'Сессия не найдена.' });
    }
    if (error.message === 'SESSION_FORBIDDEN') {
      return res.status(403).json({ message: 'Нет доступа к этой тестовой сессии.' });
    }
    if (error.message === 'SESSION_BUSY') {
      return res.status(409).json({ message: 'Агент ещё отвечает. Подождите.' });
    }
    if (error instanceof RegosCrmError) {
      return res.status(error.status!).json({ message: error.message });
    }
    if (isAiCredentialError(error)) {
      return res.status(503).json({ message: aiCredentialErrorMessage(error) });
    }
    console.error('Customer test agent error:', error);
    return res.status(500).json({ message: 'Не удалось получить ответ агента поддержки.' });
  }

  function mapCustomerTestChatError(error: Error) {
    if (error.message === 'EMPTY_MESSAGE') return 'Введите текст сообщения или прикрепите файл.';
    if (error.message === 'TICKET_NOT_FOUND') return 'Тикет не найден.';
    if (error.message === 'SESSION_NOT_FOUND') return 'Сессия не найдена.';
    if (error.message === 'SESSION_FORBIDDEN') return 'Нет доступа к этой тестовой сессии.';
    if (error.message === 'SESSION_BUSY') return 'Агент ещё отвечает. Подождите.';
    if (error instanceof RegosCrmError) return error.message;
    return mapAgentChatError(error, 'Не удалось получить ответ агента поддержки.');
  }

  function canSeeAllTestHistory(req: Request) {
    return actorHasPermission(db, getSessionActor(req), 'ai_customer_test_history');
  }

  function parseAllUsersFlag(value?: any) {
    const raw = String(value ?? '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
  }

  router.get('/api/ai/test-sessions', requireRight(db, 'ai_customer_test'), (req: Request, res: Response) => {
    try {
      const allowAnyUser = canSeeAllTestHistory(req);
      const allUsers = parseAllUsersFlag(req.query.all);
      const sessions = listCustomerTestSessions(db, {
        userId: resolveKnowledgeActorUserId(db, req),
        agentKind: req.query.agent_kind,
        allUsers,
        allowAnyUser,
      });
      return res.json({ sessions, all_users: Boolean(allUsers && allowAnyUser) });
    } catch (error: any) {
      return sendCustomerTestError(res, error);
    }
  });

  router.delete('/api/ai/test-sessions/:id', requireRight(db, 'ai_customer_test'), (req: Request, res: Response) => {
    try {
      const deleted = deleteCustomerTestSession(db, req.params.id, {
        userId: resolveKnowledgeActorUserId(db, req),
        allowAnyUser: canSeeAllTestHistory(req),
      });
      if (!deleted) {
        return res.status(404).json({ message: 'Сессия не найдена.' });
      }
      return res.json({ ok: true });
    } catch (error: any) {
      return sendCustomerTestError(res, error);
    }
  });

  router.post('/api/ai/test-sessions/clear', requireRight(db, 'ai_customer_test'), express.json(), (req: Request, res: Response) => {
    try {
      const allowAnyUser = canSeeAllTestHistory(req);
      const allUsers = parseAllUsersFlag(req.body?.all ?? req.query.all);
      const result = clearCustomerTestSessions(db, {
        userId: resolveKnowledgeActorUserId(db, req),
        agentKind: req.body?.agent_kind ?? req.query.agent_kind,
        allUsers,
        allowAnyUser,
      });
      return res.json({ ok: true, ...result });
    } catch (error: any) {
      return sendCustomerTestError(res, error);
    }
  });

  router.get('/api/ai/customer-test-session', requireRight(db, 'ai_customer_test'), async (req: Request, res: Response) => {
    try {
      const result = await loadCustomerTestSession({
        db,
        userId: resolveKnowledgeActorUserId(db, req),
        sessionId: req.query.session_id,
        requireTicket: false,
        allowAnyUser: canSeeAllTestHistory(req),
      });
      return res.json(result);
    } catch (error: any) {
      return sendCustomerTestError(res, error);
    }
  });

  router.post('/api/ai/customer-test-session', requireRight(db, 'ai_customer_test'), express.json(), async (req: Request, res: Response) => {
    try {
      const result = await loadCustomerTestSession({
        db,
        userId: resolveKnowledgeActorUserId(db, req),
        sessionId: req.body?.session_id,
        ticketId: parseOptionalTestTicketId(req.body?.ticket_id),
        clientPhone: parseOptionalTestPhone(req.body?.client_phone),
        reset: Boolean(req.body?.reset),
        allowAnyUser: canSeeAllTestHistory(req),
      });
      return res.json(result);
    } catch (error: any) {
      return sendCustomerTestError(res, error);
    }
  });

  router.post(
    '/api/ai/customer-test-chat',
    requireRight(db, 'ai_customer_test'),
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
          runCustomerTestAgent({
            db,
            userId: resolveKnowledgeActorUserId(db, req),
            sessionId: req.body?.session_id,
            message,
            files,
            ticketId: parseOptionalTestTicketId(req.body?.ticket_id),
            clientPhone: parseOptionalTestPhone(req.body?.client_phone),
            allowAnyUser: canSeeAllTestHistory(req),
            onDelta,
          }),
        { mapError: mapCustomerTestChatError }
      );
    } catch (error: any) {
      return sendCustomerTestError(res, error);
    }
  });

  router.get('/api/ai/employee-test-session', requireRight(db, 'ai_customer_test'), async (req: Request, res: Response) => {
    try {
      const result = await loadEmployeeTestSession({
        db,
        userId: resolveKnowledgeActorUserId(db, req),
        sessionId: req.query.session_id,
        requireTicket: false,
        allowAnyUser: canSeeAllTestHistory(req),
      });
      return res.json(result);
    } catch (error: any) {
      return sendCustomerTestError(res, error);
    }
  });

  router.post('/api/ai/employee-test-session', requireRight(db, 'ai_customer_test'), express.json(), async (req: Request, res: Response) => {
    try {
      const result = await loadEmployeeTestSession({
        db,
        userId: resolveKnowledgeActorUserId(db, req),
        sessionId: req.body?.session_id,
        ticketId: parseOptionalTestTicketId(req.body?.ticket_id),
        clientPhone: parseOptionalTestPhone(req.body?.client_phone),
        reset: Boolean(req.body?.reset),
        allowAnyUser: canSeeAllTestHistory(req),
      });
      return res.json(result);
    } catch (error: any) {
      return sendCustomerTestError(res, error);
    }
  });

  router.post(
    '/api/ai/employee-test-chat',
    requireRight(db, 'ai_customer_test'),
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
            runEmployeeTestAgent({
              db,
              userId: resolveKnowledgeActorUserId(db, req),
              sessionId: req.body?.session_id,
              message,
              files,
              ticketId: parseOptionalTestTicketId(req.body?.ticket_id),
              clientPhone: parseOptionalTestPhone(req.body?.client_phone),
              allowAnyUser: canSeeAllTestHistory(req),
              onDelta,
            }),
          { mapError: mapCustomerTestChatError }
        );
      } catch (error: any) {
        return sendCustomerTestError(res, error);
      }
    }
  );

}
