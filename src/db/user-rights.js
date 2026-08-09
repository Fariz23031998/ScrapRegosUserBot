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
  renotify_order: {
    column: 'renotify_order',
    label: 'Повторно уведомлять о заказах',
  },
  users_read: {
    column: 'users_read',
    label: 'Админ: пользователи — просмотр',
  },
  users_create: {
    column: 'users_create',
    label: 'Админ: пользователи — создание',
  },
  users_edit: {
    column: 'users_edit',
    label: 'Админ: пользователи — изменение',
  },
  users_delete: {
    column: 'users_delete',
    label: 'Админ: пользователи — удаление',
  },
  order_logs_read: {
    column: 'order_logs_read',
    label: 'Админ: журнал заказов — просмотр',
  },
  orders_read: {
    column: 'orders_read',
    label: 'Админ: заказы — просмотр',
  },
  orders_manage: {
    column: 'orders_manage',
    label: 'Админ: заказы — управление',
  },
  tickets_read: {
    column: 'tickets_read',
    label: 'Админ: тикеты — просмотр',
  },
  technical_support_read: {
    column: 'technical_support_read',
    label: 'Админ: техподдержка — просмотр',
  },
  technical_support_create: {
    column: 'technical_support_create',
    label: 'Админ: техподдержка — создание',
  },
  technical_support_edit: {
    column: 'technical_support_edit',
    label: 'Админ: техподдержка — изменение',
  },
  technical_support_delete: {
    column: 'technical_support_delete',
    label: 'Админ: техподдержка — удаление',
  },
  prices_read: {
    column: 'prices_read',
    label: 'Админ: прайс — просмотр',
  },
  prices_create: {
    column: 'prices_create',
    label: 'Админ: прайс — создание',
  },
  prices_edit: {
    column: 'prices_edit',
    label: 'Админ: прайс — изменение',
  },
  prices_delete: {
    column: 'prices_delete',
    label: 'Админ: прайс — удаление',
  },
};

/** Admin UI section permission keys returned by /api/session. */
const ADMIN_PERMISSION_KEYS = [
  'users_read',
  'users_create',
  'users_edit',
  'users_delete',
  'order_logs_read',
  'orders_read',
  'orders_manage',
  'tickets_read',
  'technical_support_read',
  'technical_support_create',
  'technical_support_edit',
  'technical_support_delete',
  'prices_read',
  'prices_create',
  'prices_edit',
  'prices_delete',
];

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
  ADMIN_PERMISSION_KEYS,
  hasRight,
  getRightsForTelegramUser,
  isLinkedEmployee,
};
