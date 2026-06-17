const { hasRight, isLinkedEmployee } = require('./user-rights');
const { getBotUserByTelegramId } = require('./bot-users-db');

const BASE_EMPLOYEE_COMMANDS = [
  { command: 'start', description: 'Главное меню' },
  { command: 'help', description: 'Справка по боту' },
];

const RIGHT_COMMANDS = [
  { command: 'report', right: 'see_own_report', description: 'Мой отчёт по заработку' },
  { command: 'reports', right: 'see_all_report', description: 'Отчёт по всем сотрудникам' },
  { command: 'order', right: 'see_own_unpaid_orders', description: 'Мои неоплаченные заказы' },
  { command: 'orders', right: 'see_all_unpaid_orders', description: 'Все неоплаченные заказы' },
  { command: 'vip', right: 'manage_vip', description: 'Управление VIP-клиентами' },
];

function buildCommandsForTelegramUser(db, telegramId) {
  const user = getBotUserByTelegramId(db, telegramId);
  if (!isLinkedEmployee(user)) {
    return [{ command: 'start', description: 'Проверить неоплаченные заказы' }];
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
  buildCommandsForTelegramUser,
  syncUserCommands,
  getHelpCommandLines,
};
