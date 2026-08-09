const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { answerCallbackQuerySafe, onCallbackQuery, sendChatActionSafe } = require('../src/bot/telegram-safe');

function makeFakeBot(answerImpl) {
  const listeners = [];
  return {
    listeners,
    answerCallbackQuery: answerImpl,
    sendChatAction: async () => ({ ok: true }),
    on(event, handler) {
      if (event === 'callback_query') listeners.push(handler);
    },
    emit(query) {
      return Promise.all(listeners.map((handler) => handler(query)));
    },
  };
}

function expiredQueryError() {
  const error = new Error(
    'ETELEGRAM: 400 Bad Request: query is too old and response timeout expired or query ID is invalid'
  );
  error.code = 'ETELEGRAM';
  return error;
}

describe('Telegram handler safety', () => {
  it('swallows expired callback query answers', async () => {
    const bot = makeFakeBot(async () => {
      throw expiredQueryError();
    });

    assert.equal(await answerCallbackQuerySafe(bot, 'stale-id'), false);
  });

  it('reports success when the query is still valid', async () => {
    const bot = makeFakeBot(async () => ({ ok: true }));

    assert.equal(await answerCallbackQuerySafe(bot, 'fresh-id'), true);
  });

  it('keeps a throwing handler from producing an unhandled rejection', async () => {
    const bot = makeFakeBot(async () => ({ ok: true }));
    onCallbackQuery(bot, 'test', async () => {
      throw expiredQueryError();
    });

    await assert.doesNotReject(() => bot.emit({ id: '1', data: 'test:1' }));
  });

  it('swallows sendChatAction failures', async () => {
    const bot = {
      async sendChatAction() {
        throw new Error('ETELEGRAM: 400 Bad Request: chat not found');
      },
    };
    assert.equal(await sendChatActionSafe(bot, 1), false);
  });

  it('reports success when sendChatAction works', async () => {
    const bot = {
      async sendChatAction() {
        return { ok: true };
      },
    };
    assert.equal(await sendChatActionSafe(bot, 1, 'typing'), true);
  });
});
