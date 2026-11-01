import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type TelegramBot from 'node-telegram-bot-api';
import { looksLikePhone } from './search-user';
import { addVipClient, removeVipClient, formatVipList } from './vip-clients';
import { hasRight } from '../db/user-rights';
import { isLinkedEmployee } from '../db/bot-users-db';
import { answerCallbackQuerySafe, onCallbackQuery } from './telegram-safe';

const VIP_ACCESS_DENIED = 'Доступ запрещено. Нет права на управление VIP-клиентами.';
const VIP_MENU_TEXT = 'Управление VIP-клиентами:';
const VIP_PROMPT_ADD = 'Отправьте номер телефона VIP-клиента для добавления.';
const VIP_PROMPT_DELETE = 'Отправьте номер телефона для удаления из VIP-списка.';
const VIP_INVALID_PHONE = 'Неверный номер телефона.';

const pendingActions: Map<any, any> = new Map();

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Показать список', callback_data: 'vip:view' }],
      [
        { text: 'Добавить', callback_data: 'vip:add' },
        { text: 'Удалить', callback_data: 'vip:delete' },
      ],
    ],
  };
}

function backKeyboard() {
  return {
    inline_keyboard: [[{ text: 'Назад', callback_data: 'vip:back' }]],
  };
}

function cancelKeyboard() {
  return {
    inline_keyboard: [[{ text: 'Отмена', callback_data: 'vip:cancel' }]],
  };
}

function clearPendingAction(telegramId?: any) {
  pendingActions.delete(telegramId);
}

function setPendingAction(telegramId?: any, action?: any) {
  pendingActions.set(telegramId, action);
}

function getPendingAction(telegramId?: any) {
  return pendingActions.get(telegramId) ?? null;
}

function checkManagerAccess(db: Db, botUser?: any) {
  if (!botUser) {
    return { allowed: false, message: null, needsRegistration: true };
  }
  if (!isLinkedEmployee(botUser)) {
    return { allowed: false, message: VIP_ACCESS_DENIED };
  }
  if (!hasRight(db, botUser.telegram_id, 'manage_vip')) {
    return { allowed: false, message: VIP_ACCESS_DENIED };
  }
  return { allowed: true };
}

function registerVipHandlers(bot: TelegramBot, { db, getBotUser, sendRegisterPrompt }: Unchecked) {
  bot.onText(/\/vip/, async (msg?: any) => {
    const botUser = getBotUser(msg.from.id);
    const access = checkManagerAccess(db, botUser);

    if (access.needsRegistration) {
      await sendRegisterPrompt(msg.chat.id);
      return;
    }
    if (!access.allowed) {
      await bot.sendMessage(msg.chat.id, access.message!);
      return;
    }

    clearPendingAction(msg.from.id);
    await bot.sendMessage(msg.chat.id, VIP_MENU_TEXT, {
      reply_markup: mainMenuKeyboard(),
    });
  });

  onCallbackQuery(bot, 'vip', async (query?: any) => {
    const data = query.data;
    if (!data?.startsWith('vip:')) return;

    const chatId = query.message.chat.id;
    const telegramId = query.from.id;
    const botUser = getBotUser(telegramId);
    const access = checkManagerAccess(db, botUser);

    await answerCallbackQuerySafe(bot, query.id);

    if (access.needsRegistration) {
      await sendRegisterPrompt(chatId);
      return;
    }
    if (!access.allowed) {
      await bot.sendMessage(chatId, access.message!);
      return;
    }

    switch (data) {
      case 'vip:view':
        clearPendingAction(telegramId);
        await bot.sendMessage(chatId, formatVipList(), { reply_markup: backKeyboard() });
        break;

      case 'vip:add':
        setPendingAction(telegramId, 'add');
        await bot.sendMessage(chatId, VIP_PROMPT_ADD, { reply_markup: cancelKeyboard() });
        break;

      case 'vip:delete':
        setPendingAction(telegramId, 'delete');
        await bot.sendMessage(chatId, VIP_PROMPT_DELETE, { reply_markup: cancelKeyboard() });
        break;

      case 'vip:back':
      case 'vip:cancel':
        clearPendingAction(telegramId);
        await bot.sendMessage(chatId, VIP_MENU_TEXT, { reply_markup: mainMenuKeyboard() });
        break;

      default:
        break;
    }
  });
}

async function handleVipMessage(bot: TelegramBot, msg: any, botUser: any, db: Db) {
  const pending = getPendingAction(msg.from.id);
  if (!pending) return false;

  const access = checkManagerAccess(db, botUser);
  if (!access.allowed) {
    clearPendingAction(msg.from.id);
    if (access.message) {
      await bot.sendMessage(msg.chat.id, access.message);
    }
    return true;
  }

  const phoneInput = msg.text?.trim();
  if (!phoneInput || !looksLikePhone(phoneInput)) {
    await bot.sendMessage(msg.chat.id, VIP_INVALID_PHONE, { reply_markup: cancelKeyboard() });
    return true;
  }

  const result = pending === 'add' ? addVipClient(phoneInput) : removeVipClient(phoneInput);
  clearPendingAction(msg.from.id);

  await bot.sendMessage(msg.chat.id, result.message, { reply_markup: mainMenuKeyboard() });
  return true;
}

export { registerVipHandlers, handleVipMessage };
