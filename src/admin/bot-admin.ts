import type { Db } from '../types/db';
import type { Response } from 'express';
import express from 'express';
import { buildAuditDetails } from '../db/admin-audit-logs';
import { getTicketRecording } from '../db/ticket-recordings';
import { getChatFilesByIds } from '../integrations/regos-crm';
import { botAdminPublicDir, botAdminUiDistDir } from '../paths';
import { registerTaskRoutes } from './tasks-admin';
import { registerReportRoutes } from './reports-admin';
import { registerFinancesRoutes } from './finances-admin';
import { getTicketRecordingUrl } from './ticket-recording';
import { buildDurationSummary } from './ticket-duration';
import { sendPublicFile, isBotAdminReactUiReady, sendBotAdminReactUiIndex, auditAdminChange } from './bot-admin-shared';
import { seedRecordingUrlCache, toPublicChatFile, CHAT_FILE_CACHE_TTL_MS } from './bot-admin-media';
import { registerBotAdminLoginRoutes } from './bot-admin-routes-login';
import { registerBotAdminSessionRoutes } from './bot-admin-routes-session';
import { registerBotAdminPasswordResetRoutes } from './bot-admin-routes-password-reset';
import { registerBotAdminLogRoutes } from './bot-admin-routes-logs';
import { registerBotAdminTicketListRoutes } from './bot-admin-routes-ticket-list';
import { registerBotAdminClientRoutes } from './bot-admin-routes-clients';
import { registerBotAdminChannelSettingsRoutes } from './bot-admin-routes-channel-settings';
import { registerBotAdminAiSettingsRoutes } from './bot-admin-routes-ai-settings';
import { registerBotAdminAiPromptRoutes } from './bot-admin-routes-ai-prompts';
import { registerBotAdminKnowledgeRoutes } from './bot-admin-routes-knowledge';
import { registerBotAdminKbSessionRoutes } from './bot-admin-routes-kb-session';
import { registerBotAdminOpsRoutes } from './bot-admin-routes-ops';
import { registerBotAdminTicketDetailRoutes } from './bot-admin-routes-ticket-detail';
import { registerBotAdminTicketMediaRoutes } from './bot-admin-routes-ticket-media';
import { registerBotAdminOrderRoutes } from './bot-admin-routes-orders';
import { registerBotAdminTicketsCollectionRoutes } from './bot-admin-routes-tickets';
import { registerBotAdminSupportRoutes } from './bot-admin-routes-support';
import { registerBotAdminUserRoutes } from './bot-admin-routes-users';
import { registerBotAdminPageRoutes } from './bot-admin-routes-pages';

function createBotAdminRouter(db: Db) {
  const router = express.Router();
  const publicDir = botAdminPublicDir();
  const reactUiDistDir = botAdminUiDistDir();
  const reactUiReady = isBotAdminReactUiReady();
  const recordingUrlCache: Map<any, any> = new Map();
  const chatFileCache: Map<any, any> = new Map();

  function sendBotAdminPage(res: Response, legacyFilename?: any) {
    if (reactUiReady) return sendBotAdminReactUiIndex(res);
    return sendPublicFile(res, publicDir, legacyFilename);
  }

  function getCachedChatFile(fileId?: any) {
    const key = Number(fileId);
    const entry = chatFileCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      chatFileCache.delete(key);
      return null;
    }
    return entry.file;
  }

  function setCachedChatFile(file?: any) {
    if (!file || file.id == null) return;
    chatFileCache.set(Number(file.id), {
      file,
      expiresAt: Date.now() + CHAT_FILE_CACHE_TTL_MS,
    });
  }

  async function resolveChatFiles(chatId?: any, fileIds?: any) {
    const unique = [...new Set((fileIds || []).map(Number).filter((id?: any) => Number.isFinite(id) && id > 0))];
    const byId: Map<any, any> = new Map();
    const missing: any[] = [];
    for (const id of unique) {
      const cached = getCachedChatFile(id);
      if (cached) byId.set(id, cached);
      else missing.push(id);
    }
    if (missing.length) {
      const fetched = await getChatFilesByIds(chatId, missing, { includeStaffPrivate: true });
      for (const file of fetched) {
        setCachedChatFile(file);
        byId.set(Number(file.id), file);
      }
    }
    return byId;
  }

  function attachPublicFiles(messages?: any, filesById?: any) {
    return (messages || []).map((message?: any) => {
      const fileIds = Array.isArray(message?.file_ids) ? message.file_ids : [];
      const files = fileIds
        .map((raw?: any) => {
          const id = Number(raw);
          if (!Number.isFinite(id) || id <= 0) return null;
          return toPublicChatFile(filesById.get(id)) || { id };
        })
        .filter(Boolean);
      return { ...message, files };
    });
  }

  function cacheTicketRecordingUrl(ticket?: any) {
    const url = getTicketRecordingUrl(ticket);
    if (!url || ticket?.id == null) return url;
    seedRecordingUrlCache(recordingUrlCache, ticket.id, url.href);
    return url;
  }

  function getCachedTicketRecordingUrl(ticketId?: any) {
    const key = String(ticketId);
    const cached = recordingUrlCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      recordingUrlCache.delete(key);
      return null;
    }
    return new URL(cached.href);
  }

  function resolveRecordingUrlFromStore(ticketId?: any) {
    const cached = getCachedTicketRecordingUrl(ticketId);
    if (cached) return cached;
    const row = getTicketRecording(db, ticketId);
    if (!row?.recording_url) return null;
    return seedRecordingUrlCache(recordingUrlCache, ticketId, row.recording_url);
  }

  const deps = {
    db,
    publicDir,
    reactUiDistDir,
    reactUiReady,
    recordingUrlCache,
    sendBotAdminPage,
    resolveChatFiles,
    getCachedChatFile,
    attachPublicFiles,
    cacheTicketRecordingUrl,
    getCachedTicketRecordingUrl,
    resolveRecordingUrlFromStore,
  };

  registerBotAdminLoginRoutes(router, deps);
  registerTaskRoutes(router, db, { auditAdminChange, buildAuditDetails });
  registerFinancesRoutes(router, db, { auditAdminChange, buildAuditDetails });
  registerReportRoutes(router, db);
  registerBotAdminSessionRoutes(router, deps);
  registerBotAdminPasswordResetRoutes(router, deps);
  registerBotAdminLogRoutes(router, deps);
  registerBotAdminTicketListRoutes(router, deps);
  registerBotAdminClientRoutes(router, deps);
  registerBotAdminChannelSettingsRoutes(router, deps);
  registerBotAdminAiSettingsRoutes(router, deps);
  registerBotAdminAiPromptRoutes(router, deps);
  registerBotAdminKnowledgeRoutes(router, deps);
  registerBotAdminKbSessionRoutes(router, deps);
  registerBotAdminOpsRoutes(router, deps);
  registerBotAdminTicketDetailRoutes(router, deps);
  registerBotAdminTicketMediaRoutes(router, deps);
  registerBotAdminOrderRoutes(router, deps);
  registerBotAdminTicketsCollectionRoutes(router, deps);
  registerBotAdminSupportRoutes(router, deps);
  registerBotAdminUserRoutes(router, deps);
  registerBotAdminPageRoutes(router, deps);

  return router;
}

export { createBotAdminRouter, buildDurationSummary };
