const { getBotUserByTelegramId, getUserRights, isLinkedEmployee } = require('./bot-users-db');

const RIGHTS = {
  see_own_unpaid_orders: {
    column: 'see_own_unpaid_orders',
    label: 'Свои неоплаченные заказы (созданные сотрудником)',
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
  mark_paid_cash: {
    column: 'mark_paid_cash',
    label: 'Отмечать оплату наличными',
  },
  open_admin_dashboard: {
    column: 'open_admin_dashboard',
    label: 'Открывать админ-панель (/open_dashboard)',
  },
  create_technical_support: {
    column: 'create_technical_support',
    label: 'Создавать подписки технической поддержки',
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
