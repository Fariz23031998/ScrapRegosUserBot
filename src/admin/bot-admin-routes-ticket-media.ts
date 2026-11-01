import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { buildAuditDetails } from '../db/admin-audit-logs';
import { requireRight } from './bot-admin-auth';
import { enrichChatMessages } from './chat-system-message';
import { upsertTicketRecording } from '../db/ticket-recordings';
import { RegosCrmError, setTicketResponsible, findTicketById, getTicketMessages, addTicketMessage, addChatFile, ensureTicketParticipant, isTicketStaffParticipant, DEFAULT_CHAT_MESSAGE_LIMIT } from '../integrations/regos-crm';
import { ticketEventHub } from './ticket-events';
import { CHAT_MESSAGE_JSON_LIMIT, parseChatUploadFiles } from '../ai/chat-uploads';
import { resolveSessionRegosUserId, buildRegosUserNameMap, auditAdminChange } from './bot-admin-shared';
import { collectMessageFileIds, isSafeFileUrl, resolveChatFileContentType, fetchUpstreamMedia } from './bot-admin-media';

export function registerBotAdminTicketMediaRoutes(router: any, deps: { db: Db; resolveChatFiles: (chatId?: any, fileIds?: any) => Promise<any>; getCachedChatFile: (fileId?: any) => any; attachPublicFiles: (messages?: any, filesById?: any) => any; cacheTicketRecordingUrl: (ticket?: any) => any; resolveRecordingUrlFromStore: (ticketId?: any) => any }) {
  const { db, resolveChatFiles, getCachedChatFile, attachPublicFiles, cacheTicketRecordingUrl, resolveRecordingUrlFromStore } = deps;
  router.get('/api/tickets/:id/recording', requireRight(db, 'tickets_read'), async (req: Request, res: Response) => {
    const abortController = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    try {
      let recordingUrl = resolveRecordingUrlFromStore(req.params.id);
      if (!recordingUrl) {
        const ticket = await findTicketById(req.params.id);
        if (!ticket) {
          return res.status(404).json({ message: 'Тикет не найден.' });
        }
        recordingUrl = cacheTicketRecordingUrl(ticket);
        if (recordingUrl) {
          upsertTicketRecording(db, {
            ticketId: ticket.id,
            recordingUrl: recordingUrl.href,
          });
        }
      }
      if (!recordingUrl) {
        return res.status(404).json({ message: 'Запись звонка не найдена.' });
      }

      const range = String(req.headers.range || '').trim();
      const upstream = await fetchUpstreamMedia(recordingUrl, {
        range,
        signal: abortController.signal,
      });

      if (![200, 206].includes(upstream.status) || !upstream.body) {
        console.error(
          `[bot-admin] Recording server returned ${upstream.status} for ticket ${req.params.id}`
        );
        return res.status(502).json({ message: 'Не удалось загрузить запись звонка.' });
      }

      res.status(upstream.status);
      for (const header of [
        'accept-ranges',
        'content-length',
        'content-range',
        'content-type',
        'etag',
        'last-modified',
      ]) {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Disposition', 'inline');
      await pipeline(Readable.fromWeb(upstream.body as any), res);
      return undefined;
    } catch (error: any) {
      if (abortController.signal.aborted) return undefined;
      console.error('Get ticket recording error:', error);
      if (res.headersSent) {
        res.destroy(error);
        return undefined;
      }
      if (error instanceof RegosCrmError) {
        return res.status(error.status!).json({ message: error.message });
      }
      return res.status(502).json({ message: 'Не удалось загрузить запись звонка.' });
    }
  });

  router.get('/api/tickets/:id/messages', requireRight(db, 'tickets_read'), async (req: Request, res: Response) => {
    try {
      const ticket = await findTicketById(req.params.id);
      if (!ticket) {
        return res.status(404).json({ message: 'Тикет не найден.' });
      }

      const chatId = ticket.chat_id ? String(ticket.chat_id).trim() : '';
      if (!chatId) {
        return res.json({
          chat_id: null,
          messages: [],
          next_offset: 0,
          total: 0,
          offset: 0,
          has_older: false,
        });
      }

      const limit = Math.min(
        100,
        Math.max(1, Number(req.query.limit) || DEFAULT_CHAT_MESSAGE_LIMIT)
      );
      // ChatMessage/Get is newest-first: offset 0 is the latest page.
      // from_end is accepted for compatibility and maps to that latest page.
      const offset = Math.max(0, Number(req.query.offset) || 0);

      const page = await getTicketMessages(chatId, {
        limit,
        offset,
        includeStaffPrivate: true,
      });

      let filesById: Map<any, any> = new Map();
      try {
        filesById = await resolveChatFiles(chatId, collectMessageFileIds(page.result));
      } catch (fileError: any) {
        console.error('Get ticket chat files error:', fileError);
      }

      let userNames: Unchecked = {};
      try {
        userNames = await buildRegosUserNameMap();
      } catch (userError: any) {
        console.error('Get ticket chat user names error:', userError);
      }

      const messages = enrichChatMessages(attachPublicFiles(page.result, filesById), {
        ticketId: ticket.id,
        userNames,
      });
      const total = Number(page.total) || messages.length;
      const nextOffset = page.next_offset ?? page.offset + messages.length;

      return res.json({
        chat_id: chatId,
        messages,
        next_offset: nextOffset,
        total,
        offset: page.offset,
        has_older: nextOffset < total,
      });
    } catch (error: any) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status!).json({ message: error.message });
      }
      console.error('Get ticket messages error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить сообщения чата.' });
    }
  });

  router.post(
    '/api/tickets/:id/messages',
    requireRight(db, 'tickets_read'),
    express.json({ limit: CHAT_MESSAGE_JSON_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const ticket = await findTicketById(req.params.id);
        if (!ticket) {
          return res.status(404).json({ message: 'Тикет не найден.' });
        }

        const chatId = ticket.chat_id ? String(ticket.chat_id).trim() : '';
        if (!chatId) {
          return res.status(400).json({ message: 'Чат не привязан к этому тикету.' });
        }

        let files: any;
        try {
          files = parseChatUploadFiles(req.body?.files);
        } catch (parseError: any) {
          return res.status(parseError.status || 400).json({
            message: parseError.message || 'Некорректный файл.',
          });
        }

        const text = String(req.body?.text || '').trim();
        if (!text && files.length === 0) {
          return res.status(400).json({ message: 'Введите текст сообщения или прикрепите файл.' });
        }

        const regosUserId = resolveSessionRegosUserId(db, req);
        if (!regosUserId) {
          return res.status(400).json({
            message:
              'Чтобы отвечать в чате тикета, привяжите аккаунт REGOS к сотруднику ' +
              '(Пользователи → связь с REGOS). Вход через общий логин без привязки не подходит.',
          });
        }

        if (!isTicketStaffParticipant(ticket, regosUserId)) {
          try {
            await ensureTicketParticipant(ticket.id, regosUserId);
          } catch (participantError: any) {
            if (participantError instanceof RegosCrmError) {
              return res.status(participantError.status!).json({
                message:
                  'Вы не участник этого тикета в REGOS, и не удалось добавить вас автоматически. ' +
                  'Назначьте себя участником/ответственным в regos.online или выдайте интеграции ' +
                  `право crm_ticket_participant_manage (745). ${participantError.message}`,
              });
            }
            throw participantError;
          }
        }

        const currentResponsibleId = Number(ticket.responsible_user_id);
        if (!Number.isInteger(currentResponsibleId) || currentResponsibleId <= 0) {
          await setTicketResponsible(ticket.id, regosUserId);
        }

        const fileIds: any[] = [];
        for (const file of files) {
          const uploaded = await addChatFile({
            chatId,
            name: file.name,
            extension: file.extension,
            data: file.data,
            width: file.width,
            height: file.height,
          });
          if (uploaded.file_id) {
            fileIds.push(uploaded.file_id);
          }
        }

        const created = await addTicketMessage({
          chatId,
          text,
          fileIds,
          authorEntityId: regosUserId,
          authorEntityType: 'User',
        });
        auditAdminChange(db, req, {
          entityType: 'ticket',
          entityId: ticket.id,
          action: 'send_message',
          summary: `Сообщение в тикет #${ticket.id}`,
          details: buildAuditDetails({
            before: null,
            after: {
              chat_id: chatId,
              message_id: created.id,
              text_preview: text.slice(0, 120),
              file_ids: fileIds,
            },
          }),
        });
        const payload: Unchecked = {
          id: created.id,
          chat_id: chatId,
          author_entity_id: regosUserId,
        };
        if (fileIds.length) {
          payload.file_ids = fileIds;
        }
        ticketEventHub.publish({
          type: 'chat_changed',
          chat_id: chatId,
          message_id: created.id != null ? String(created.id) : null,
          source_action: 'ChatMessageAdded',
          occurred_at: new Date().toISOString(),
        });
        return res.status(201).json(payload);
      } catch (error: any) {
        if (error instanceof RegosCrmError) {
          return res.status(error.status!).json({ message: error.message });
        }
        console.error('Send ticket message error:', error);
        return res.status(500).json({ message: 'Не удалось отправить сообщение.' });
      }
    }
  );

  router.get('/api/tickets/:id/files/:fileId', requireRight(db, 'tickets_read'), async (req: Request, res: Response) => {
    const abortController = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    try {
      const ticket = await findTicketById(req.params.id);
      if (!ticket) {
        return res.status(404).json({ message: 'Тикет не найден.' });
      }
      const chatId = ticket.chat_id ? String(ticket.chat_id).trim() : '';
      if (!chatId) {
        return res.status(404).json({ message: 'Чат не привязан к этому тикету.' });
      }

      const fileId = Number(req.params.fileId);
      if (!Number.isFinite(fileId) || fileId <= 0) {
        return res.status(400).json({ message: 'Некорректный файл.' });
      }

      let file = getCachedChatFile(fileId);
      if (!file) {
        const filesById = await resolveChatFiles(chatId, [fileId]);
        file = filesById.get(fileId) || null;
      }
      if (!file) {
        return res.status(404).json({ message: 'Файл не найден.' });
      }
      if (!isSafeFileUrl(file.url)) {
        return res.status(502).json({ message: 'Не удалось загрузить файл.' });
      }

      const range = String(req.headers.range || '').trim();
      const upstream = await fetchUpstreamMedia(file.url, {
        range,
        signal: abortController.signal,
      });
      if (![200, 206].includes(upstream.status) || !upstream.body) {
        console.error(
          `[bot-admin] Chat file server returned ${upstream.status} for ticket ${req.params.id} file ${fileId}`
        );
        return res.status(502).json({ message: 'Не удалось загрузить файл.' });
      }

      res.status(upstream.status);
      const contentType = resolveChatFileContentType(file, upstream.headers.get('content-type'));
      res.setHeader('Content-Type', contentType);
      for (const header of ['accept-ranges', 'content-length', 'content-range', 'etag', 'last-modified']) {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      const filename = file.name || `file-${fileId}${file.extension ? `.${file.extension}` : ''}`;
      res.setHeader(
        'Content-Disposition',
        `inline; filename*=UTF-8''${encodeURIComponent(filename)}`
      );
      res.setHeader('Cache-Control', 'private, max-age=300');
      await pipeline(Readable.fromWeb(upstream.body as any), res);
      return undefined;
    } catch (error: any) {
      if (abortController.signal.aborted) return undefined;
      console.error('Get ticket chat file error:', error);
      if (res.headersSent) {
        res.destroy(error);
        return undefined;
      }
      if (error instanceof RegosCrmError) {
        return res.status(error.status!).json({ message: error.message });
      }
      return res.status(502).json({ message: 'Не удалось загрузить файл.' });
    }
  });

}
