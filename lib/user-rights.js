const { getBotUserByTelegramId, getUserRights, isLinkedEmployee } = require('./bot-users-db');

const RIGHTS = {
  see_own_unpaid_orders: {
    column: 'see_own_unpaid_orders',
    label: 'Видеть свои неоплаченные заказы (как клиент)',
  },
  see_own_report: {
    column: 'see_own_report',
    label: 'Отчёт по себе',
  },
  see_all_report: {
    column: 'see_all_report',
    label: 'Отчёт по всем',
  },
  delete_unpaid_order: {
    column: 'delete_unpaid_order',
    label: 'Удалять неоплаченные заказы',
  },
  manage_vip: {
    column: 'manage_vip',
    label: 'Управление VIP-клиентами',
  },
  see_all_unpaid_orders: {
    column: 'see_all_unpaid_orders',
    label: 'Неоплаченные заказы всех клиентов',
  },
};

function hasRight(db, telegramId, rightKey) {
  const user = getBotUserByTelegramId(db, telegramId);
  if (!isLinkedEmployee(user)) return false;
  const rights = getUserRights(db, user.id);
  return Boolean(rights[rightKey]);
}

function getRightsForTelegramUser(db, telegramId) {
  const user = getBotUserByTelegramId(db, telegramId);
  if (!user) return null;
  return getUserRights(db, user.id);
}

module.exports = {
  RIGHTS,
  hasRight,
  getRightsForTelegramUser,
  isLinkedEmployee,
};
