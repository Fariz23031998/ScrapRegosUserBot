// Telegram callback queries expire quickly and become invalid after a bot
// restart. Answering an expired query rejects with ETELEGRAM 400, which would
// otherwise surface as an unhandled rejection and kill the process.
async function answerCallbackQuerySafe(bot, queryId, options) {
  try {
    await bot.answerCallbackQuery(queryId, options);
    return true;
  } catch (error) {
    console.warn('[telegram] answerCallbackQuery failed:', error.message);
    return false;
  }
}

// Keeps a single failing update from crashing the long-running bot process.
function onCallbackQuery(bot, name, handler) {
  bot.on('callback_query', async (query) => {
    try {
      await handler(query);
    } catch (error) {
      console.error(`[telegram] ${name} callback failed:`, error.message);
    }
  });
}

module.exports = {
  answerCallbackQuerySafe,
  onCallbackQuery,
};
