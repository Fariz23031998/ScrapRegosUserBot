import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { buildAuditDetails } from '../db/admin-audit-logs';
import { requireRight } from './bot-admin-auth';
import { findTicketById, getChatFilesByIds } from '../integrations/regos-crm';
import { loadAiSettings, saveAiSettings, serializeAiSettings } from '../ai/settings';
import { notifyGroupTopic } from '../ai/tools/notify-group';
import { listToolSchemas, runAgentToolTest } from '../ai/tools/test-runner';
import { auditAdminChange } from './bot-admin-shared';

export function registerBotAdminAiSettingsRoutes(router: any, deps: { db: Db }) {
  const { db } = deps;
  router.get('/api/settings/ai', requireRight(db, 'settings_read'), (_req: any, res: Response) => {
    try {
      return res.json(serializeAiSettings(loadAiSettings(db)));
    } catch (error: any) {
      console.error('Load AI settings error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить настройки AI.' });
    }
  });

  router.put('/api/settings/ai', requireRight(db, 'settings_edit'), express.json(), (req: Request, res: Response) => {
    try {
      const before = loadAiSettings(db);
      const patch: Unchecked = {
        enabled: req.body?.enabled,
        testMode: req.body?.test_mode ?? req.body?.testMode,
        provider: req.body?.provider,
        model: req.body?.model,
        agentModels: req.body?.agent_models ?? req.body?.agentModels,
        agentMaxSteps: req.body?.agent_max_steps ?? req.body?.agentMaxSteps,
        transcribeModel: req.body?.transcribe_model ?? req.body?.transcribeModel,
        reasoningEffort: req.body?.reasoning_effort ?? req.body?.reasoningEffort,
        historyLimit: req.body?.history_limit ?? req.body?.historyLimit,
        customerRepliesPerHour:
          req.body?.customer_replies_per_hour ?? req.body?.customerRepliesPerHour,
        customerRepliesPerTicket:
          req.body?.customer_replies_per_ticket ?? req.body?.customerRepliesPerTicket,
        groupChatId: req.body?.group_chat_id ?? req.body?.groupChatId,
        groupTopics: req.body?.group_topics ?? req.body?.groupTopics,
        disabledTools: req.body?.disabled_tools ?? req.body?.disabledTools,
        disabledAgentTools: req.body?.disabled_agent_tools ?? req.body?.disabledAgentTools,
        defaultAgentTools: req.body?.default_agent_tools ?? req.body?.defaultAgentTools,
        ignoredCustomerMessages:
          req.body?.ignored_customer_messages ?? req.body?.ignoredCustomerMessages,
      };
      if (
        Object.prototype.hasOwnProperty.call(req.body || {}, 'openai_api_key') ||
        Object.prototype.hasOwnProperty.call(req.body || {}, 'openaiApiKey')
      ) {
        patch.openaiApiKey = req.body?.openai_api_key ?? req.body?.openaiApiKey;
      }
      if (
        Object.prototype.hasOwnProperty.call(req.body || {}, 'openai_base_url') ||
        Object.prototype.hasOwnProperty.call(req.body || {}, 'openaiBaseUrl')
      ) {
        patch.openaiBaseUrl = req.body?.openai_base_url ?? req.body?.openaiBaseUrl;
      }
      if (
        Object.prototype.hasOwnProperty.call(req.body || {}, 'gemini_api_key') ||
        Object.prototype.hasOwnProperty.call(req.body || {}, 'geminiApiKey')
      ) {
        patch.geminiApiKey = req.body?.gemini_api_key ?? req.body?.geminiApiKey;
      }
      const saved = saveAiSettings(db, patch);
      auditAdminChange(db, req, {
        entityType: 'ai_settings',
        entityId: null,
        action: 'update',
        summary: 'Обновлены настройки AI',
        details: buildAuditDetails({
          before: serializeAiSettings(before),
          after: serializeAiSettings(saved),
        }),
      });
      return res.json({ ok: true, ...serializeAiSettings(saved) });
    } catch (error: any) {
      if (
        error.message === 'INVALID_AI_PROVIDER' ||
        error.message === 'INVALID_AI_MODEL' ||
        error.message === 'INVALID_AI_AGENT_MODELS' ||
        error.message === 'INVALID_AI_AGENT_MAX_STEPS' ||
        error.message === 'INVALID_AI_TRANSCRIBE_MODEL' ||
        error.message === 'INVALID_AI_REASONING_EFFORT' ||
        error.message === 'INVALID_AI_HISTORY_LIMIT' ||
        error.message === 'INVALID_AI_CUSTOMER_REPLY_LIMIT' ||
        error.message === 'INVALID_AI_GROUP_CHAT_ID' ||
        error.message === 'INVALID_AI_GROUP_TOPICS' ||
        error.message === 'INVALID_AI_DISABLED_TOOLS' ||
        error.message === 'INVALID_AI_IGNORED_CUSTOMER_MESSAGES' ||
        error.message === 'INVALID_AI_API_KEY' ||
        error.message === 'INVALID_AI_BASE_URL'
      ) {
        return res.status(400).json({ message: 'Некорректные настройки AI.' });
      }
      console.error('Save AI settings error:', error);
      return res.status(500).json({ message: 'Не удалось сохранить настройки AI.' });
    }
  });

  router.post('/api/settings/ai/group-test', requireRight(db, 'settings_edit'), express.json(), async (req: Request, res: Response) => {
    const topicKey = String(req.body?.topic_key || req.body?.topicKey || '').trim();
    const message = String(req.body?.message || '').trim();
    try {
      const result = await notifyGroupTopic(db, {
        topicKey,
        message: message ? `Тест из bot-admin:\n\n${message}` : '',
      });
      if (!result.ok) {
        const error = result.error || 'notify_failed';
        const status =
          error === 'not_configured' || error === 'unknown_topic' || error === 'empty_message'
            ? 400
            : error === 'no_bot'
              ? 503
              : 502;
        const messages = {
          not_configured: 'Сначала сохраните ID группы и хотя бы одну тему.',
          unknown_topic: 'Тема не найдена в сохранённом списке.',
          empty_message: 'Введите текст сообщения.',
          no_bot: 'Не задан TELEGRAM_BOT_TOKEN.',
        };
        return res.status(status).json({
          ok: false,
          error,
          message: (messages as Record<string, string>)[error] || `Не удалось отправить: ${error}`,
        });
      }
      auditAdminChange(db, req, {
        entityType: 'ai_group_topic',
        entityId: result.topic_key,
        action: 'test',
        summary: `Тестовое сообщение в тему ${result.topic_name || result.topic_key}`,
        details: buildAuditDetails({
          topic_key: result.topic_key,
          topic_name: result.topic_name,
        }),
      });
      return res.json({
        ok: true,
        topic_key: result.topic_key,
        topic_name: result.topic_name,
      });
    } catch (error: any) {
      console.error('Test AI group topic error:', error);
      return res.status(500).json({ message: 'Не удалось отправить тестовое сообщение.' });
    }
  });

  router.get('/api/settings/ai/tools', requireRight(db, 'settings_read'), (_req: any, res: Response) => {
    try {
      return res.json({ tools: listToolSchemas({ db }) });
    } catch (error: any) {
      console.error('List AI tools error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить инструменты.' });
    }
  });

  router.post('/api/settings/ai/tools/test', requireRight(db, 'settings_edit'), express.json(), async (req: Request, res: Response) => {
    const toolName = String(req.body?.tool_name || req.body?.toolName || '').trim();
    const ticketId = req.body?.ticket_id ?? req.body?.ticketId ?? null;
    let args = req.body?.arguments ?? req.body?.args ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        return res.status(400).json({ ok: false, error: 'invalid_arguments', message: 'Аргументы должны быть JSON-объектом.' });
      }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return res.status(400).json({ ok: false, error: 'invalid_arguments', message: 'Аргументы должны быть JSON-объектом.' });
    }

    try {
      const result = await runAgentToolTest({
        db,
        toolName,
        args,
        ticketId,
        deps: {
          findTicketById,
          getChatFilesByIds,
        },
      });
      if (!result.ok) {
        const status =
          result.error === 'unknown_tool' ||
          result.error === 'ticket_required' ||
          result.error === 'invalid_arguments'
            ? 400
            : result.error === 'ticket_not_found'
              ? 404
              : result.error === 'execute_failed'
                ? 500
                : 400;
        return res.status(status).json(result);
      }
      auditAdminChange(db, req, {
        entityType: 'ai_tool',
        entityId: toolName,
        action: 'test',
        summary: `Тест инструмента ${toolName}`,
        details: buildAuditDetails({
          tool_name: toolName,
          ticket_id: ticketId,
          duration_ms: (result as { duration_ms?: number }).duration_ms,
        }),
      });
      return res.json(result);
    } catch (error: any) {
      console.error('Test AI tool error:', error);
      return res.status(500).json({ ok: false, error: 'execute_failed', message: 'Не удалось выполнить инструмент.' });
    }
  });

}
