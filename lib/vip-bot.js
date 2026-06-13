const { looksLikePhone } = require('./search-user');
const { addVipClient, removeVipClient, formatVipList } = require('./vip-clients');
const { isVipManager, isVipManagerConfigured } = require('./vip-manager');

const VIP_ACCESS_DENIED = 'Доступ запрещено. Команда только для VIP-менеджера.';
const VIP_CONFIG_ERROR = 'VIP-менеджер не настроен. Укажите VIP_MANAGER_PHONE в .env.';
const VIP_MENU_TEXT = 'Управление VIP-клиентами:';
const VIP_PROMPT_ADD = 'Отправьте номер телефона VIP-клиента для добавления.';
const VIP_PROMPT_DELETE = 'Отправьте номер телефона для удаления из VIP-списка.';
const VIP_INVALID_PHONE = 'Неверный номер телефона.';

const pendingActions = new Map();

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

function clearPendingAction(telegramId) {
  pendingActions.delete(telegramId);
}

function setPendingAction(telegramId, action) {
  pendingActions.set(telegramId, action);
}

function getPendingAction(telegramId) {
  return pendingActions.get(telegramId) ?? null;
}

function checkManagerAccess(botUser) {
  if (!isVipManagerConfigured()) {
    return { allowed: false, message: VIP_CONFIG_ERROR };
  }
  if (!botUser) {
    return { allowed: false, message: null, needsRegistration: true };
  }
  if (!isVipManager(botUser.phone)) {
    return { allowed: false, message: VIP_ACCESS_DENIED };
  }
  return { allowed: true };
}

function registerVipHandlers(bot, { getBotUser, sendRegisterPrompt }) {
  bot.onText(/\/vip/, async (msg) => {
    const botUser = getBotUser(msg.from.id);
    const access = checkManagerAccess(botUser);

    if (access.needsRegistration) {
      await sendRegisterPrompt(msg.chat.id);
      return;
    }
    if (!access.allowed) {
      await bot.sendMessage(msg.chat.id, access.message);
      return;
    }

    clearPendingAction(msg.from.id);
    await bot.sendMessage(msg.chat.id, VIP_MENU_TEXT, {
      reply_markup: mainMenuKeyboard(),
    });
  });

  bot.on('callback_query', async (query) => {
    const data = query.data;
    if (!data?.startsWith('vip:')) return;

    const chatId = query.message.chat.id;
    const telegramId = query.from.id;
    const botUser = getBotUser(telegramId);
    const access = checkManagerAccess(botUser);

    await bot.answerCallbackQuery(query.id);

    if (access.needsRegistration) {
      await sendRegisterPrompt(chatId);
      return;
    }
    if (!access.allowed) {
      await bot.sendMessage(chatId, access.message);
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

async function handleVipMessage(bot, msg, botUser) {
  const pending = getPendingAction(msg.from.id);
  if (!pending) return false;

  const access = checkManagerAccess(botUser);
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

module.exports = {
  registerVipHandlers,
  handleVipMessage,
};
