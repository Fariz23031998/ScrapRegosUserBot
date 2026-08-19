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
  delete_cash_order: {
    column: 'delete_cash_order',
    label: 'Удалять заказы „Наличные“',
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
  logs_read: {
    column: 'logs_read',
    label: 'Админ: журнал изменений — просмотр',
  },
  orders_read: {
    column: 'orders_read',
    label: 'Админ: заказы — просмотр',
  },
  tickets_read: {
    column: 'tickets_read',
    label: 'Админ: тикеты — просмотр',
  },
  tickets_create: {
    column: 'tickets_create',
    label: 'Админ: тикеты — создание',
  },
  tickets_edit: {
    column: 'tickets_edit',
    label: 'Админ: тикеты — изменение',
  },
  tickets_edit_closed: {
    column: 'tickets_edit_closed',
    label: 'Админ: тикеты — изменение закрытых',
  },
  tickets_ai_prompt: {
    column: 'tickets_ai_prompt',
    label: 'Админ: тикеты — просмотр промпта ИИ',
  },
  clients_edit: {
    column: 'clients_edit',
    label: 'Админ: клиенты — изменение',
  },
  clients_link_firm: {
    column: 'clients_link_firm',
    label: 'Админ: клиенты — связь с фирмой',
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
  settings_read: {
    column: 'settings_read',
    label: 'Админ: настройки — просмотр',
  },
  settings_edit: {
    column: 'settings_edit',
    label: 'Админ: настройки — изменение',
  },
  finances_read: {
    column: 'finances_read',
    label: 'Админ: финансы — просмотр',
  },
  finances_create: {
    column: 'finances_create',
    label: 'Админ: финансы — создание',
  },
  finances_delete: {
    column: 'finances_delete',
    label: 'Админ: финансы — удаление',
  },
  knowledge_read: {
    column: 'knowledge_read',
    label: 'Админ: база знаний — просмотр',
  },
  knowledge_edit: {
    column: 'knowledge_edit',
    label: 'Админ: база знаний — изменение',
  },
  knowledge_lock: {
    column: 'knowledge_lock',
    label: 'Админ: база знаний — блокировка',
  },
  knowledge_unlock: {
    column: 'knowledge_unlock',
    label: 'Админ: база знаний — разблокировка',
  },
  knowledge_confirm: {
    column: 'knowledge_confirm',
    label: 'Админ: база знаний — подтверждение',
  },
  ai_customer_test: {
    column: 'ai_customer_test',
    label: 'Админ: тест агентов',
  },
  ai_customer_test_history: {
    column: 'ai_customer_test_history',
    label: 'Админ: тест агентов — история всех',
  },
  prompt_variables_create: {
    column: 'prompt_variables_create',
    label: 'Админ: промпты — создание переменных',
  },
  tasks_read: {
    column: 'tasks_read',
    label: 'Админ: задачи — просмотр',
  },
  tasks_create: {
    column: 'tasks_create',
    label: 'Админ: задачи — создание',
  },
  tasks_edit: {
    column: 'tasks_edit',
    label: 'Админ: задачи — изменение',
  },
  tasks_delete: {
    column: 'tasks_delete',
    label: 'Админ: задачи — удаление',
  },
  tasks_payment_create: {
    column: 'tasks_payment_create',
    label: 'Админ: задачи — приём оплаты',
  },
  tasks_payment_delete: {
    column: 'tasks_payment_delete',
    label: 'Админ: задачи — удаление оплаты',
  },
  tasks_post: {
    column: 'tasks_post',
    label: 'Админ: задачи — проведение',
  },
  tasks_unpost: {
    column: 'tasks_unpost',
    label: 'Админ: задачи — отмена проведения',
  },
  tasks_status: {
    column: 'tasks_status',
    label: 'Админ: задачи — изменение статуса',
  },
  tasks_manager: {
    column: 'tasks_manager',
    label: 'Админ: задачи — изменение менеджера',
  },
  tasks_technician: {
    column: 'tasks_technician',
    label: 'Админ: задачи — изменение техника',
  },
  devices_read: {
    column: 'devices_read',
    label: 'Админ: устройства — просмотр',
  },
  devices_create: {
    column: 'devices_create',
    label: 'Админ: устройства — создание',
  },
  devices_edit: {
    column: 'devices_edit',
    label: 'Админ: устройства — изменение',
  },
  devices_delete: {
    column: 'devices_delete',
    label: 'Админ: устройства — удаление',
  },
  services_read: {
    column: 'services_read',
    label: 'Админ: услуги — просмотр',
  },
  services_create: {
    column: 'services_create',
    label: 'Админ: услуги — создание',
  },
  services_edit: {
    column: 'services_edit',
    label: 'Админ: услуги — изменение',
  },
  services_delete: {
    column: 'services_delete',
    label: 'Админ: услуги — удаление',
  },
};

/** Admin UI section permission keys returned by /api/session. */
const ADMIN_PERMISSION_KEYS = [
  'users_read',
  'users_create',
  'users_edit',
  'users_delete',
  'order_logs_read',
  'logs_read',
  'see_all_report',
  'orders_read',
  'delete_unpaid_order',
  'delete_cash_order',
  'mark_paid_cash',
  'renotify_order',
  'tickets_read',
  'tickets_create',
  'tickets_edit',
  'tickets_edit_closed',
  'tickets_ai_prompt',
  'clients_edit',
  'clients_link_firm',
  'technical_support_read',
  'technical_support_create',
  'technical_support_edit',
  'technical_support_delete',
  'prices_read',
  'prices_create',
  'prices_edit',
  'prices_delete',
  'settings_read',
  'settings_edit',
  'finances_read',
  'finances_create',
  'finances_delete',
  'knowledge_read',
  'knowledge_edit',
  'knowledge_lock',
  'knowledge_unlock',
  'knowledge_confirm',
  'ai_customer_test',
  'ai_customer_test_history',
  'prompt_variables_create',
  'tasks_read',
  'tasks_create',
  'tasks_edit',
  'tasks_delete',
  'tasks_payment_create',
  'tasks_payment_delete',
  'tasks_post',
  'tasks_unpost',
  'tasks_status',
  'tasks_manager',
  'tasks_technician',
  'devices_read',
  'devices_create',
  'devices_edit',
  'devices_delete',
  'services_read',
  'services_create',
  'services_edit',
  'services_delete',
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
