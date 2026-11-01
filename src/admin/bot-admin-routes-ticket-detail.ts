import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { buildAuditDetails } from '../db/admin-audit-logs';
import { requireRight } from './bot-admin-auth';
import { enrichTicketsWithLocalData } from './ticket-local-enrichment';
import { upsertTicketRecording } from '../db/ticket-recordings';
import { setTicketAiStopped, isTicketAiStopped } from '../db/ticket-ai-state';
import { RegosCrmError, findTicketById } from '../integrations/regos-crm';
import { respondAgentChat } from '../http/agent-chat-sse';
import { previewCustomerAgentPrompt } from '../ai/customer-agent';
import { loadTicketAssistSession, runTicketAssistAgent, previewTicketAssistPrompt } from '../ai/customer-assist-agent';
import { CHAT_MESSAGE_JSON_LIMIT, parseChatUploadFiles } from '../ai/chat-uploads';
import { getTicketSummary, saveTicketSummaryText, deleteTicketSummary } from '../db/ticket-summaries';
import { resolveTicketClientId } from '../ai/ticket-period';
import { isAiCredentialError, aiCredentialErrorMessage, mapAgentChatError, auditAdminChange, resolveKnowledgeActorUserId } from './bot-admin-shared';

export function registerBotAdminTicketDetailRoutes(router: any, deps: { db: Db; cacheTicketRecordingUrl: (ticket?: any) => any }) {
  const { db, cacheTicketRecordingUrl } = deps;
  router.get('/api/tickets/:id', requireRight(db, 'tickets_read'), async (req: Request, res: Response) => {
    try {
      const ticket = await findTicketById(req.params.id);
      if (!ticket) {
        return res.status(404).json({ message: 'Тикет не найден.' });
      }
      const recordingUrl = cacheTicketRecordingUrl(ticket);
      if (recordingUrl) {
        upsertTicketRecording(db, {
          ticketId: ticket.id,
          recordingUrl: recordingUrl.href,
        });
      }
      const [enriched] = enrichTicketsWithLocalData(db, [ticket]);
      return res.json({ ticket: enriched || ticket });
    } catch (error: any) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status!).json({ message: error.message });
      }
      console.error('Get ticket error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить тикет.' });
    }
  });

  router.put(
    '/api/tickets/:id/ai-state',
    requireRight(db, 'tickets_edit'),
    express.json(),
    async (req: Request, res: Response) => {
      try {
        const ticket = await findTicketById(req.params.id);
        if (!ticket) {
          return res.status(404).json({ message: 'Тикет не найден.' });
        }
        const raw =
          req.body?.ai_stopped ?? req.body?.aiStopped ?? req.body?.stopped;
        if (raw == null) {
          return res.status(400).json({ message: 'Укажите ai_stopped.' });
        }
        const stopped =
          raw === true ||
          raw === 1 ||
          raw === '1' ||
          String(raw).trim().toLowerCase() === 'true';
        const before = isTicketAiStopped(db, ticket.id);
        const state = setTicketAiStopped(db, ticket.id, stopped);
        auditAdminChange(db, req, {
          entityType: 'ticket_ai_state',
          entityId: ticket.id,
          action: stopped ? 'stop' : 'resume',
          summary: stopped
            ? `Остановлены автоответы клиенту для тикета #${ticket.id}`
            : `Возобновлены автоответы клиенту для тикета #${ticket.id}`,
          details: buildAuditDetails({
            before: { ai_stopped: before },
            after: { ai_stopped: Boolean(state?.ai_stopped) },
          }),
        });
        return res.json({
          ok: true,
          ticket_id: ticket.id,
          ai_stopped: Boolean(state?.ai_stopped),
          updated_at: state?.updated_at || null,
        });
      } catch (error: any) {
        if (error?.code === 'INVALID_TICKET_ID') {
          return res.status(400).json({ message: 'Некорректный ID тикета.' });
        }
        if (error instanceof RegosCrmError) {
          return res.status(error.status!).json({ message: error.message });
        }
        console.error('Update ticket AI state error:', error);
        return res.status(500).json({ message: 'Не удалось обновить состояние ИИ тикета.' });
      }
    }
  );

  router.get('/api/tickets/:id/ai-prompt', requireRight(db, 'tickets_ai_prompt'), async (req: Request, res: Response) => {
    try {
      const rawMessageId = req.query.message_id != null ? String(req.query.message_id).trim() : '';
      const preview = await previewCustomerAgentPrompt({
        db,
        ticketId: req.params.id,
        messageId: rawMessageId || undefined,
      });
      return res.json(preview);
    } catch (error: any) {
      if (error?.code === 'ticket-not-found') {
        return res.status(404).json({ message: 'Тикет не найден.' });
      }
      if (error instanceof RegosCrmError) {
        return res.status(error.status!).json({ message: error.message });
      }
      console.error('Get ticket AI prompt error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить промпт ИИ.' });
    }
  });

  router.get('/api/tickets/:id/ai-assist-prompt', requireRight(db, 'tickets_ai_prompt'), async (req: Request, res: Response) => {
    try {
      const preview = await previewTicketAssistPrompt({
        db,
        userId: resolveKnowledgeActorUserId(db, req),
        ticketId: req.params.id,
        sessionId: req.query.session_id,
      });
      return res.json(preview);
    } catch (error: any) {
      if (error.message === 'TICKET_NOT_FOUND' || error.message === 'INVALID_TICKET_ID') {
        return res.status(404).json({ message: 'Тикет не найден.' });
      }
      if (error instanceof RegosCrmError) {
        return res.status(error.status!).json({ message: error.message });
      }
      console.error('Get ticket assist AI prompt error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить промпт ИИ.' });
    }
  });

  async function resolveSummaryTicketContext(ticketId?: any) {
    try {
      return await findTicketById(ticketId);
    } catch (error: any) {
      if (error instanceof RegosCrmError && error.status === 404) return null;
      console.warn('[bot-admin] Failed to load ticket for summary:', error.message || error);
      return null;
    }
  }

  router.put(
    '/api/tickets/:id/summary',
    requireRight(db, 'tickets_ai_prompt'),
    express.json(),
    async (req: Request, res: Response) => {
      try {
        const existing = getTicketSummary(db, req.params.id);
        const bodyClientId = req.body?.client_id ?? req.body?.clientId;
        const bodyChatId = req.body?.chat_id ?? req.body?.chatId;
        const ticket =
          existing || bodyClientId != null || bodyChatId != null
            ? null
            : await resolveSummaryTicketContext(req.params.id);
        const summary = saveTicketSummaryText(db, req.params.id, req.body?.summary, {
          clientId: bodyClientId ?? (ticket ? resolveTicketClientId(ticket) : undefined),
          chatId: bodyChatId ?? ticket?.chat_id,
        });
        auditAdminChange(db, req, {
          entityType: 'ticket_summary',
          entityId: summary!.ticket_id,
          action: existing ? 'update' : 'create',
          summary: existing
            ? `Изменена сводка обращения #${summary!.ticket_id}`
            : `Создана сводка обращения #${summary!.ticket_id}`,
          details: buildAuditDetails({ before: existing, after: summary }),
        });
        return res.json({ summary });
      } catch (error: any) {
        if (error.message === 'INVALID_TICKET_ID') {
          return res.status(400).json({ message: 'Некорректный идентификатор тикета.' });
        }
        if (error.message === 'INVALID_SUMMARY') {
          return res.status(400).json({ message: 'Введите текст сводки.' });
        }
        console.error('Save ticket summary error:', error);
        return res.status(500).json({ message: 'Не удалось сохранить сводку обращения.' });
      }
    }
  );

  router.delete('/api/tickets/:id/summary', requireRight(db, 'tickets_ai_prompt'), (req: Request, res: Response) => {
    try {
      const before = deleteTicketSummary(db, req.params.id);
      if (!before) {
        return res.status(404).json({ message: 'Сводка обращения не найдена.' });
      }
      auditAdminChange(db, req, {
        entityType: 'ticket_summary',
        entityId: before.ticket_id,
        action: 'delete',
        summary: `Удалена сводка обращения #${before.ticket_id}`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true });
    } catch (error: any) {
      if (error.message === 'INVALID_TICKET_ID') {
        return res.status(400).json({ message: 'Некорректный идентификатор тикета.' });
      }
      console.error('Delete ticket summary error:', error);
      return res.status(500).json({ message: 'Не удалось удалить сводку обращения.' });
    }
  });

  function sendTicketAssistError(res: Response, error: Error) {
    if (error.message === 'EMPTY_MESSAGE') {
      return res.status(400).json({ message: 'Введите текст сообщения или прикрепите файл.' });
    }
    if (error.message === 'TICKET_NOT_FOUND' || error.message === 'INVALID_TICKET_ID') {
      return res.status(404).json({ message: 'Тикет не найден.' });
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
    console.error('Ticket AI assist error:', error);
    return res.status(500).json({ message: 'Не удалось получить ответ агента поддержки.' });
  }

  function mapTicketAssistChatError(error: Error) {
    if (error.message === 'EMPTY_MESSAGE') return 'Введите текст сообщения или прикрепите файл.';
    if (error.message === 'TICKET_NOT_FOUND' || error.message === 'INVALID_TICKET_ID') return 'Тикет не найден.';
    if (error.message === 'SESSION_BUSY') return 'Агент ещё отвечает. Подождите.';
    if (error instanceof RegosCrmError) return error.message;
    return mapAgentChatError(error, 'Не удалось получить ответ агента поддержки.');
  }

  router.get('/api/tickets/:id/ai-assist', requireRight(db, 'tickets_read'), async (req: Request, res: Response) => {
    try {
      const result = await loadTicketAssistSession({
        db,
        userId: resolveKnowledgeActorUserId(db, req),
        ticketId: req.params.id,
        sessionId: req.query.session_id,
      });
      return res.json(result);
    } catch (error: any) {
      return sendTicketAssistError(res, error);
    }
  });

  router.post('/api/tickets/:id/ai-assist', requireRight(db, 'tickets_read'), express.json(), async (req: Request, res: Response) => {
    try {
      const result = await loadTicketAssistSession({
        db,
        userId: resolveKnowledgeActorUserId(db, req),
        ticketId: req.params.id,
        sessionId: req.body?.session_id,
        reset: Boolean(req.body?.reset),
      });
      return res.json(result);
    } catch (error: any) {
      return sendTicketAssistError(res, error);
    }
  });

  router.post(
    '/api/tickets/:id/ai-assist-chat',
    requireRight(db, 'tickets_read'),
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
            runTicketAssistAgent({
              db,
              userId: resolveKnowledgeActorUserId(db, req),
              ticketId: req.params.id,
              sessionId: req.body?.session_id,
              message,
              files,
              onDelta,
            }),
          { mapError: mapTicketAssistChatError }
        );
      } catch (error: any) {
        return sendTicketAssistError(res, error);
      }
    }
  );

}
