import type TelegramBot from 'node-telegram-bot-api';

// Telegram callback queries expire quickly and become invalid after a bot
// restart. Answering an expired query rejects with ETELEGRAM 400, which would
// otherwise surface as an unhandled rejection and kill the process.
async function answerCallbackQuerySafe(bot: TelegramBot, queryId?: any, options?: any) {
  try {
    await bot.answerCallbackQuery(queryId, options);
    return true;
  } catch (error: any) {
    console.warn('[telegram] answerCallbackQuery failed:', error.message);
    return false;
  }
}

async function sendChatActionSafe(bot: TelegramBot, chatId: any, action: any = 'typing') {
  try {
    await bot.sendChatAction(chatId, action);
    return true;
  } catch (error: any) {
    console.warn('[telegram] sendChatAction failed:', error.message);
    return false;
  }
}

// Keeps a single failing update from crashing the long-running bot process.
function onCallbackQuery(bot: TelegramBot, name?: any, handler?: any) {
  bot.on('callback_query', async (query?: any) => {
    try {
      await handler(query);
    } catch (error: any) {
      console.error(`[telegram] ${name} callback failed:`, error.message);
    }
  });
}

export { answerCallbackQuerySafe, sendChatActionSafe, onCallbackQuery };
