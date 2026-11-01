import type { Unchecked } from '../../types/unchecked';
import type { Db } from '../../types/db';
import { loadAiSettings } from '../settings';
import { buildEmployeeNotifyText } from './notify-employee';

const TELEGRAM_MAX_MESSAGE = 4096;

function truncateTelegramText(text?: any) {
  const value = String(text || '');
  if (value.length <= TELEGRAM_MAX_MESSAGE) return value;
  return `${value.slice(0, TELEGRAM_MAX_MESSAGE - 3)}...`;
}

function loadAgentGroupConfig(db: Db) {
  const settings = loadAiSettings(db);
  const chatId = String(settings.groupChatId || '').trim();
  const topics = Array.isArray(settings.groupTopics) ? settings.groupTopics : [];
  if (!chatId || topics.length === 0) return null;
  return { chatId, topics };
}

function listAgentGroupTopics(db: Db) {
  const config = loadAgentGroupConfig(db);
  if (!config) return { ok: false, error: 'not_configured' };
  return {
    ok: true,
    topics: config.topics.map((topic?: any) => ({
      key: topic.key,
      name: topic.name,
      when: topic.when || null,
    })),
  };
}

function resolveGroupTopic(config?: any, topicKey?: any) {
  const needle = String(topicKey || '').trim().toLowerCase();
  if (!needle) return null;
  return config.topics.find((topic?: any) => topic.key === needle) || null;
}

async function notifyGroupTopic(db: Db, { topicKey, message, ticketId, client, sendTelegram }: Unchecked = {}) {
  const config = loadAgentGroupConfig(db);
  if (!config) return { ok: false, error: 'not_configured' };
  const topic = resolveGroupTopic(config, topicKey);
  if (!topic) return { ok: false, error: 'unknown_topic' };

  const text = truncateTelegramText(buildEmployeeNotifyText({ message, ticketId, client }));
  if (!text) return { ok: false, error: 'empty_message' };

  const send =
    sendTelegram ||
    (async (chatId?: any, body?: any, options?: any) => {
      const { getOutboundBot } = (require('../../bot/payment-notification') as typeof import('../../bot/payment-notification'));
      const bot = getOutboundBot();
      if (!bot) throw new Error('no_bot');
      await bot.sendMessage(chatId, body, options);
    });

  try {
    await send(config.chatId, text, { message_thread_id: topic.id });
    return {
      ok: true,
      topic_key: topic.key,
      topic_name: topic.name,
    };
  } catch (error: any) {
    return { ok: false, error: error.message || 'notify_failed' };
  }
}

export {
  loadAgentGroupConfig,
  listAgentGroupTopics,
  notifyGroupTopic,
  truncateTelegramText,
};
