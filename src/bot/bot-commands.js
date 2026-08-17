const { hasRight, isLinkedEmployee } = require('../db/user-rights');
const { getBotUserByTelegramId } = require('../db/bot-users-db');

const PUBLIC_COMMANDS = [
  { command: 'prices', description: 'Прайс услуг / Xizmatlar narxlari' },
];

const BASE_EMPLOYEE_COMMANDS = [
  { command: 'start', description: 'Главное меню' },
  { command: 'help', description: 'Справка по боту' },
  ...PUBLIC_COMMANDS,
];

const RIGHT_COMMANDS = [
  { command: 'report', right: 'see_own_report', description: 'Мой отчёт по заработку за период' },
  { command: 'reports', right: 'see_all_report', description: 'Отчёт по всем сотрудникам за период' },
  { command: 'order', right: 'see_own_unpaid_orders', description: 'Мои неоплаченные заказы' },
  { command: 'orders', right: 'see_all_unpaid_orders', description: 'Все неоплаченные заказы' },
  { command: 'vip', right: 'manage_vip', description: 'Управление VIP-клиентами' },
  // Telegram BotCommand names allow only [a-z0-9_]; open-dashboard is accepted as an alias in the handler.
  { command: 'open_dashboard', right: 'open_admin_dashboard', description: 'Open Admin Dashboard' },
];

function buildDefaultBotCommands() {
  return [
    { command: 'start', description: 'Начать работу с ботом' },
    ...PUBLIC_COMMANDS,
  ];
}

function buildCommandsForTelegramUser(db, telegramId) {
  const user = getBotUserByTelegramId(db, telegramId);
  if (!isLinkedEmployee(user)) {
    return [
      { command: 'start', description: 'Начать / привязать профиль' },
      { command: 'my_unpaid_orders', description: 'Мои неоплаченные заказы' },
      ...PUBLIC_COMMANDS,
    ];
  }

  const commands = [...BASE_EMPLOYEE_COMMANDS];
  for (const item of RIGHT_COMMANDS) {
    if (hasRight(db, telegramId, item.right)) {
      commands.push({ command: item.command, description: item.description });
    }
  }
  return commands;
}

async function syncUserCommands(bot, db, telegramId) {
  const commands = buildCommandsForTelegramUser(db, telegramId);
  try {
    await bot.setMyCommands(commands, {
      scope: { type: 'chat', chat_id: telegramId },
    });
  } catch (error) {
    console.error(`Failed to sync commands for ${telegramId}:`, error.message);
  }
}

function getHelpCommandLines(db, telegramId) {
  const commands = buildCommandsForTelegramUser(db, telegramId);
  const lines = commands
    .filter((item) => item.command !== 'start')
    .map((item) => `/${item.command} — ${item.description}`);
  return lines.length ? ['Команды:', ...lines] : [];
}

module.exports = {
  PUBLIC_COMMANDS,
  buildDefaultBotCommands,
  buildCommandsForTelegramUser,
  syncUserCommands,
  getHelpCommandLines,
};
