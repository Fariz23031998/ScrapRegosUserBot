import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { loadAiSettings, resolveAgentModel, resolveAgentMaxSteps } from './settings';
import { runAgent, truncateText, prependUserContext, buildPromptCacheKey } from './run-agent';
import { getProvider } from './providers/registry';
import { createCustomerTools } from './tools/customer';
import { prepareAgentTools } from './tools/catalog';
import { logAdminAudit } from '../db/admin-audit-logs';
import { CUSTOMER_SYSTEM_PROMPT } from './default-prompts';
import { downloadChatFile, historyHasAudioTranscript, historyHasVisionParts } from './chat-media';
import { transcribeChatAudio } from './transcribe';
import { claimCustomerMessage, isCustomerMessageClaimed, releaseCustomerMessageClaim, claimCustomerChat, releaseCustomerChat } from '../db/customer-message-claims';
import { getTelegramTicketSessionByTicketId, getTelegramTicketSessionByChatId } from '../db/telegram-ticket-sessions';
import { resolveAiAuthorUserId, isClientRegularMessage, isSystemMessage, hasReplyAfterTrigger, pickTriggerMessage, resolveCustomerTrigger, isIgnoredCustomerMessage, evaluateCustomerMessageGate, evaluateCustomerReplyQuota, evaluateCustomerMessageGateWithDb } from './customer-agent-gates';
import { formatMessageText, buildCustomerSystemPrompt, buildCustomerContextContent, buildCustomerModelMessages, loadCustomerAgentChatContext, previewCustomerAgentPrompt } from './customer-agent-prompt';

const inflightChats: Set<any> = new Set();
const pendingCustomerChats: Map<any, any> = new Map();
const inflightClients: Set<any> = new Set();
const pendingClientWork: Map<any, any> = new Map();
const processedCustomerMessages: Map<any, any> = new Map();
const PROCESSED_MESSAGE_TTL_MS = 60 * 60 * 1000;

function processedMessageKey(chatId?: any, messageId?: any) {
  return `${chatId}:${messageId}`;
}

function cleanupProcessedMessages(nowMs: any = Date.now()) {
  for (const [key, processedAt] of processedCustomerMessages) {
    if (nowMs - processedAt >= PROCESSED_MESSAGE_TTL_MS) {
      processedCustomerMessages.delete(key);
    }
  }
}

function markCustomerMessageProcessed(chatId: any, messageId: any, db: Db) {
  const id = String(messageId || '').trim();
  if (!id) return;
  cleanupProcessedMessages();
  processedCustomerMessages.set(processedMessageKey(chatId, id), Date.now());
  if (db) claimCustomerMessage(db, chatId, id);
}

function isCustomerMessageProcessed(chatId: any, messageId: any, db: Db) {
  const id = String(messageId || '').trim();
  if (!id) return false;
  cleanupProcessedMessages();
  if (processedCustomerMessages.has(processedMessageKey(chatId, id))) return true;
  return isCustomerMessageClaimed(db, chatId, id);
}

function auditAiEvent(db: Db, { ticketId, action, summary, details }: Unchecked) {
  if (!db) return;
  try {
    logAdminAudit(db, {
      entityType: 'ticket',
      entityId: ticketId ?? null,
      action,
      summary,
      details,
      actor: null,
    });
  } catch (error: any) {
    console.error('[ai] Failed to write audit log:', error);
  }
}

async function deliverCustomerReplyToTelegram(db: Db, { ticket, chatId, reply, deps = {} }: Unchecked = {}) {
  const text = String(reply || '').trim();
  if (!db || !text) return { sent: false, reason: 'no-reply' };
  const session =
    getTelegramTicketSessionByTicketId(db, ticket?.id) ||
    getTelegramTicketSessionByChatId(db, chatId || ticket?.chat_id);
  if (!session?.telegramId) return { sent: false, reason: 'no-session' };

  const send =
    deps.sendTelegramCustomerReply ||
    (async (telegramId?: any, body?: any) => {
      const { getOutboundBot } = (require('../bot/payment-notification') as typeof import('../bot/payment-notification'));
      const bot = getOutboundBot();
      if (!bot) throw new Error('no_bot');
      await bot.sendMessage(telegramId, body);
    });

  try {
    await send(session.telegramId, text);
    return { sent: true, telegramId: session.telegramId };
  } catch (error: any) {
    console.error(
      `[ai] failed to send customer reply to Telegram ticket=${ticket?.id}:`,
      error.message || error
    );
    return { sent: false, reason: 'send-failed' };
  }
}

async function handleCustomerChatMessage({
  db,
  chatId,
  messageId,
  payload,
  forceHandle = false,
  deps = {},
}: Unchecked = {}) {
  const id = String(chatId || '').trim();
  if (!id) return { handled: false, reason: 'no-chat' };
  if (inflightChats.has(id)) {
    if (forceHandle || isClientRegularMessage(payload) || isSystemMessage(payload)) {
      pendingCustomerChats.set(id, { messageId, payload, forceHandle });
    }
    return { handled: false, reason: 'busy' };
  }

  const loadSettings = deps.loadAiSettings || loadAiSettings;
  const settings = loadSettings(db);
  const model = resolveAgentModel(settings, 'customer');
  if (!settings.enabled) {
    console.info('[ai] skip customer message: disabled');
    return { handled: false, reason: 'disabled' };
  }

  inflightChats.add(id);
  let chatLocked = false;
  try {
    if (db) {
      chatLocked = claimCustomerChat(db, id);
      if (!chatLocked) {
        return { handled: false, reason: 'busy' };
      }
    }
    const findTicket = deps.findTicketByChatId || (require('../integrations/regos-crm') as typeof import('../integrations/regos-crm')).findTicketByChatId;
    const addTicketMessage = deps.addTicketMessage || (require('../integrations/regos-crm') as typeof import('../integrations/regos-crm')).addTicketMessage;
    const ensureParticipant =
      deps.ensureTicketParticipant || (require('../integrations/regos-crm') as typeof import('../integrations/regos-crm')).ensureTicketParticipant;
    const isParticipant =
      deps.isTicketStaffParticipant || (require('../integrations/regos-crm') as typeof import('../integrations/regos-crm')).isTicketStaffParticipant;
    const download = deps.downloadChatFile || downloadChatFile;
    const transcribeFn = deps.transcribeChatAudio || transcribeChatAudio;
    const run = deps.runAgent || runAgent;
    const provider = deps.provider || getProvider(settings.provider);

    const ticket = await findTicket(id);
    if (!ticket) return { handled: false, reason: 'ticket-not-found' };
    const transcribe = (file: any, options: any = {}) =>
      transcribeFn(file, { db, ticketId: ticket.id, source: 'transcribe', ...options });

    const { messages, trigger, filesById } = await loadCustomerAgentChatContext({
      chatId: id,
      messageId,
      payload,
      historyLimit: settings.historyLimit,
      ticket,
      deps,
    });
    if (!trigger) return { handled: false, reason: 'message-not-found' };
    if (isCustomerMessageProcessed(id, trigger.id, db)) {
      return { handled: false, reason: 'already-processed' };
    }

    const gate = evaluateCustomerMessageGateWithDb(db, {
      settings,
      message: forceHandle
        ? { ...trigger, author_entity_type: 'Client', message_type: 'Regular' }
        : trigger,
      ticket,
      chatId: id,
    });
    if (!gate.handle) {
      if (gate.reason === 'ticket-cap') {
        (require('../db/ticket-ai-state') as typeof import('../db/ticket-ai-state')).setTicketAiStopped(db, ticket.id, true);
      }
      console.info(`[ai] skip customer message: ${gate.reason} chat=${id} ticket=${ticket.id}`);
      auditAiEvent(db, {
        ticketId: ticket.id,
        action: 'ai_skip',
        summary: `AI пропустил тикет #${ticket.id}: ${gate.reason}`,
        details: { reason: gate.reason, model },
      });
      return { handled: false, reason: gate.reason };
    }

    const authorEntityId = resolveAiAuthorUserId();
    if (!authorEntityId) {
      console.warn(
        '[ai] skip customer message: AI_REGOS_AUTHOR_USER_ID is not set. ' +
          'REGOS requires a linked User who is a ticket participant.'
      );
      auditAiEvent(db, {
        ticketId: ticket.id,
        action: 'ai_skip',
        summary: `AI пропустил тикет #${ticket.id}: no-author`,
        details: { reason: 'no-author', model },
      });
      return { handled: false, reason: 'no-author' };
    }

    if (!isParticipant(ticket, authorEntityId)) {
      try {
        await ensureParticipant(ticket.id, authorEntityId);
      } catch (error: any) {
        console.error(
          `[ai] could not add AI author ${authorEntityId} to ticket ${ticket.id}:`,
          error
        );
        auditAiEvent(db, {
          ticketId: ticket.id,
          action: 'ai_skip',
          summary: `AI пропустил тикет #${ticket.id}: not-participant`,
          details: { reason: 'not-participant', model },
        });
        return { handled: false, reason: 'not-participant' };
      }
    }

    if (hasReplyAfterTrigger(messages, trigger, authorEntityId)) {
      markCustomerMessageProcessed(id, trigger.id, db);
      console.info(`[ai] skip customer message: already-replied chat=${id} ticket=${ticket.id}`);
      auditAiEvent(db, {
        ticketId: ticket.id,
        action: 'ai_skip',
        summary: `AI пропустил тикет #${ticket.id}: already-replied`,
        details: { reason: 'already-replied', model },
      });
      return { handled: false, reason: 'already-replied' };
    }

    const { resolveCustomerUsageKey, recordCustomerUsage } = (require('../db/ai-customer-usage') as typeof import('../db/ai-customer-usage'));
    const { incrementCustomerReplyCount, setTicketAiStopped } = (require('../db/ticket-ai-state') as typeof import('../db/ticket-ai-state'));
    const clientKey = resolveCustomerUsageKey(ticket, id);
    if (inflightClients.has(clientKey)) {
      pendingClientWork.set(clientKey, { db, chatId: id, messageId, payload, forceHandle, deps });
      return { handled: false, reason: 'busy' };
    }
    inflightClients.add(clientKey);
    try {
      const quota = evaluateCustomerReplyQuota(db, { settings, ticket, chatId: id });
      if (!quota.handle) {
        if (quota.reason === 'ticket-cap') {
          setTicketAiStopped(db, ticket.id, true);
        }
        console.info(`[ai] skip customer message: ${quota.reason} chat=${id} ticket=${ticket.id}`);
        auditAiEvent(db, {
          ticketId: ticket.id,
          action: 'ai_skip',
          summary: `AI пропустил тикет #${ticket.id}: ${quota.reason}`,
          details: { reason: quota.reason, model },
        });
        return { handled: false, reason: quota.reason };
      }

      const claimed = db && String(trigger.id || '').trim() ? claimCustomerMessage(db, id, trigger.id) : true;
      if (!claimed) {
        markCustomerMessageProcessed(id, trigger.id, db);
        return { handled: false, reason: 'already-processed' };
      }

      const releaseClaim = () => {
        if (claimed && db) releaseCustomerMessageClaim(db, id, trigger.id);
      };

      try {
        const history = await buildCustomerModelMessages({
          messages,
          trigger,
          filesById,
          download,
          transcribe,
          transcribeModel: settings.transcribeModel,
          historyLimit: settings.historyLimit,
          db,
          ticketId: ticket.id,
        });
        if (!history.length) {
          releaseClaim();
          return { handled: false, reason: 'empty-history' };
        }

        let closeRequested = false;
        const setTicketStatus =
          deps.setTicketStatus || (require('../integrations/regos-crm') as typeof import('../integrations/regos-crm')).setTicketStatus;

        const preparedTools = prepareAgentTools(
            createCustomerTools({
              db,
              ticket,
              chatId: id,
              filesById,
              deps: {
                ...deps,
                transcribeModel: settings.transcribeModel,
                onTicketClose: () => {
                  closeRequested = true;
                },
              },
            }),
            { db, settings, agentSlug: 'customer', ticket },
          );
        const result = await run({
          provider,
          providerName: settings.provider,
          model,
          system: buildCustomerSystemPrompt(db, ticket),
          messages: prependUserContext(history, buildCustomerContextContent(db, ticket)),
          promptCacheKey: buildPromptCacheKey('customer', ticket.id),
          tools: preparedTools.activeTools,
          toolPool: preparedTools.toolPool,
          reasoningEffort: settings.reasoningEffort,
          hasVision: historyHasVisionParts(history),
          hasAudio: historyHasAudioTranscript(history),
          maxSteps: resolveAgentMaxSteps(settings, 'customer'),
        });

        const reply = truncateText(result.content);
        if (!reply) {
          releaseClaim();
          return { handled: false, reason: 'empty-reply' };
        }

        try {
          await addTicketMessage({
            chatId: id,
            text: reply,
            authorEntityType: 'User',
            authorEntityId,
          });
        } catch (error: any) {
          releaseClaim();
          console.error(`[ai] failed to send reply to ticket ${ticket.id}:`, error);
          auditAiEvent(db, {
            ticketId: ticket.id,
            action: 'ai_skip',
            summary: `AI не смог отправить ответ в тикет #${ticket.id}`,
            details: { reason: 'send-failed', model },
          });
          return { handled: false, reason: 'send-failed' };
        }

        recordCustomerUsage(db, { ticketId: ticket.id, clientKey });
        const nextCount = incrementCustomerReplyCount(db, ticket.id);
        const perTicket = Number(settings.customerRepliesPerTicket);
        if (Number.isInteger(perTicket) && perTicket > 0 && nextCount >= perTicket) {
          setTicketAiStopped(db, ticket.id, true);
        }

        let closed = false;
        if (closeRequested) {
          try {
            await setTicketStatus(ticket.id, 'Closed');
            closed = true;
          } catch (error: any) {
            console.error(`[ai] failed to close ticket ${ticket.id}:`, error);
            auditAiEvent(db, {
              ticketId: ticket.id,
              action: 'ai_skip',
              summary: `AI не смог закрыть тикет #${ticket.id}`,
              details: { reason: 'close-failed', model },
            });
          }
        }

        markCustomerMessageProcessed(id, trigger.id, db);
        const telegram = await deliverCustomerReplyToTelegram(db, {
          ticket,
          chatId: id,
          reply,
          deps,
        });
        auditAiEvent(db, {
          ticketId: ticket.id,
          action: 'ai_reply',
          summary: closed
            ? `AI ответил и закрыл тикет #${ticket.id}`
            : `AI ответил в тикет #${ticket.id}`,
          details: {
            model,
            provider: settings.provider,
            steps: result.steps,
            closed,
            telegram_sent: Boolean(telegram.sent),
          },
        });
        return { handled: true, reason: null, reply, closed, telegram_sent: Boolean(telegram.sent) };
      } catch (error: any) {
        releaseClaim();
        throw error;
      }
    } finally {
      inflightClients.delete(clientKey);
      const pendingClient = pendingClientWork.get(clientKey);
      if (pendingClient) {
        pendingClientWork.delete(clientKey);
        setImmediate(() => {
          handleCustomerChatMessage(pendingClient).catch((error: Error) => {
            console.error('[ai] customer agent failed', error);
          });
        });
      }
    }
  } finally {
    if (chatLocked) releaseCustomerChat(db, id);
    inflightChats.delete(id);
    const pending = pendingCustomerChats.get(id);
    if (pending) {
      pendingCustomerChats.delete(id);
      setImmediate(() => {
        handleCustomerChatMessage({
          db,
          chatId: id,
          messageId: pending.messageId,
          payload: pending.payload,
          forceHandle: pending.forceHandle,
          deps,
        }).catch((error: Error) => {
          console.error('[ai] customer agent failed', error);
        });
      });
    }
  }
}

function resetCustomerAgentLocks() {
  inflightChats.clear();
  pendingCustomerChats.clear();
  inflightClients.clear();
  pendingClientWork.clear();
  processedCustomerMessages.clear();
}

export {
  CUSTOMER_SYSTEM_PROMPT,
  evaluateCustomerMessageGate,
  evaluateCustomerMessageGateWithDb,
  evaluateCustomerReplyQuota,
  isIgnoredCustomerMessage,
  handleCustomerChatMessage,
  previewCustomerAgentPrompt,
  buildCustomerSystemPrompt,
  buildCustomerContextContent,
  buildCustomerModelMessages,
  loadCustomerAgentChatContext,
  resolveCustomerTrigger,
  pickTriggerMessage,
  formatMessageText,
  resetCustomerAgentLocks,
  resolveAiAuthorUserId,
  markCustomerMessageProcessed,
  isCustomerMessageProcessed,
  deliverCustomerReplyToTelegram,
};
