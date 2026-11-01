import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { answerCallbackQuerySafe, onCallbackQuery, sendChatActionSafe } from '../src/bot/telegram-safe';

function makeFakeBot(answerImpl?: any) {
  const listeners: any[] = [];
  return {
    listeners,
    answerCallbackQuery: answerImpl,
    sendChatAction: async () => ({ ok: true }),
    on(event?: any, handler?: any) {
      if (event === 'callback_query') listeners.push(handler);
    },
    emit(query?: any) {
      return Promise.all(listeners.map((handler?: any) => handler(query)));
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

    assert.equal(await answerCallbackQuerySafe((bot as any), 'stale-id'), false);
  });

  it('reports success when the query is still valid', async () => {
    const bot = makeFakeBot(async () => ({ ok: true }));

    assert.equal(await answerCallbackQuerySafe((bot as any), 'fresh-id'), true);
  });

  it('keeps a throwing handler from producing an unhandled rejection', async () => {
    const bot = makeFakeBot(async () => ({ ok: true }));
    onCallbackQuery((bot as any), 'test', async () => {
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
    assert.equal(await sendChatActionSafe((bot as any), 1), false);
  });

  it('reports success when sendChatAction works', async () => {
    const bot = {
      async sendChatAction() {
        return { ok: true };
      },
    };
    assert.equal(await sendChatActionSafe((bot as any), 1, 'typing'), true);
  });
});
