const { loadAiSettings } = require('../settings');
const { buildEmployeeNotifyText } = require('./notify-employee');

const TELEGRAM_MAX_MESSAGE = 4096;

function truncateTelegramText(text) {
  const value = String(text || '');
  if (value.length <= TELEGRAM_MAX_MESSAGE) return value;
  return `${value.slice(0, TELEGRAM_MAX_MESSAGE - 3)}...`;
}

function loadAgentGroupConfig(db) {
  const settings = loadAiSettings(db);
  const chatId = String(settings.groupChatId || '').trim();
  const topics = Array.isArray(settings.groupTopics) ? settings.groupTopics : [];
  if (!chatId || topics.length === 0) return null;
  return { chatId, topics };
}

function listAgentGroupTopics(db) {
  const config = loadAgentGroupConfig(db);
  if (!config) return { ok: false, error: 'not_configured' };
  return {
    ok: true,
    topics: config.topics.map((topic) => ({
      key: topic.key,
      name: topic.name,
      when: topic.when || null,
    })),
  };
}

function resolveGroupTopic(config, topicKey) {
  const needle = String(topicKey || '').trim().toLowerCase();
  if (!needle) return null;
  return config.topics.find((topic) => topic.key === needle) || null;
}

async function notifyGroupTopic(db, { topicKey, message, ticketId, sendTelegram } = {}) {
  const config = loadAgentGroupConfig(db);
  if (!config) return { ok: false, error: 'not_configured' };
  const topic = resolveGroupTopic(config, topicKey);
  if (!topic) return { ok: false, error: 'unknown_topic' };

  const text = truncateTelegramText(buildEmployeeNotifyText({ message, ticketId }));
  if (!text) return { ok: false, error: 'empty_message' };

  const send =
    sendTelegram ||
    (async (chatId, body, options) => {
      const { getOutboundBot } = require('../../bot/payment-notification');
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
  } catch (error) {
    return { ok: false, error: error.message || 'notify_failed' };
  }
}

module.exports = {
  loadAgentGroupConfig,
  listAgentGroupTopics,
  notifyGroupTopic,
};
