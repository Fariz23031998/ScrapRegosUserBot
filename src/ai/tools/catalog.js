/** Catalog of toggleable AI agent tools (settings UI + filtering). */

const AGENT_TOOL_CATALOG = [
  {
    name: 'search_knowledge',
    title: 'Поиск в базе знаний',
    description: 'Поиск статей внутренней базы знаний по ключевым словам.',
    agents: ['customer', 'customer_assist', 'kb'],
  },
  {
    name: 'get_article',
    title: 'Читать статью',
    description: 'Загрузить полную статью базы знаний по id.',
    agents: ['customer', 'customer_assist', 'kb'],
  },
  {
    name: 'web_search',
    title: 'Поиск в интернете',
    description: 'Публичный веб-поиск (заголовки, ссылки, сниппеты).',
    agents: ['customer', 'customer_assist', 'kb'],
  },
  {
    name: 'browse_url',
    title: 'Открыть страницу',
    description: 'Прочитать содержимое URL (порталы только для чтения).',
    agents: ['customer', 'customer_assist', 'kb'],
  },
  {
    name: 'create_article',
    title: 'Создать статью',
    description: 'Создать новую статью в базе знаний.',
    agents: ['kb'],
  },
  {
    name: 'update_article',
    title: 'Обновить статью',
    description: 'Изменить существующую статью базы знаний.',
    agents: ['kb'],
  },
  {
    name: 'delete_article',
    title: 'Удалить статью',
    description: 'Удалить статью базы знаний.',
    agents: ['kb'],
  },
  {
    name: 'search_chat_history',
    title: 'История чата',
    description: 'Читать сообщения текущего обращения и сводки прошлых тикетов.',
    agents: ['customer', 'customer_assist'],
  },
  {
    name: 'search_orders',
    title: 'Поиск заказов',
    description: 'Найти заказы клиента или партнёра.',
    agents: ['customer', 'customer_assist'],
  },
  {
    name: 'search_client',
    title: 'Поиск клиента',
    description: 'Найти клиента или фирму по телефону, имени или ИНН.',
    agents: ['customer', 'customer_assist'],
  },
  {
    name: 'get_prices',
    title: 'Прайс-лист',
    description: 'Загрузить каталог цен и тарифы техподдержки.',
    agents: ['customer', 'customer_assist'],
  },
  {
    name: 'get_employee',
    title: 'Поиск сотрудника',
    description: 'Найти сотрудника по имени, телефону или должности.',
    agents: ['customer', 'customer_assist'],
  },
  {
    name: 'notify_employee',
    title: 'Уведомить сотрудника',
    description: 'Отправить сообщение сотруднику в Telegram.',
    agents: ['customer', 'customer_assist'],
  },
  {
    name: 'list_group_topics',
    title: 'Список тем группы',
    description: 'Показать темы внутренней Telegram-группы для сообщений.',
    agents: ['customer', 'customer_assist'],
  },
  {
    name: 'send_group_topic_message',
    title: 'Сообщение в тему группы',
    description: 'Написать в тему внутренней Telegram-группы сотрудников.',
    agents: ['customer', 'customer_assist'],
  },
  {
    name: 'assign_responsible',
    title: 'Назначить ответственного',
    description: 'Назначить ответственного пользователя REGOS по тикету.',
    agents: ['customer', 'customer_assist'],
  },
  {
    name: 'read_chat_image',
    title: 'Читать изображение',
    description: 'Загрузить изображение из чата по file_id для анализа.',
    agents: ['customer', 'customer_assist'],
  },
  {
    name: 'transcribe_chat_audio',
    title: 'Расшифровка аудио',
    description: 'Расшифровать голосовое или аудио из чата по file_id.',
    agents: ['customer', 'customer_assist'],
  },
  {
    name: 'reply_to_customer',
    title: 'Ответ клиенту',
    description: 'Отправить сообщение клиенту в чат тикета (агент поддержки для сотрудников).',
    agents: ['customer_assist'],
  },
];

const KNOWN_TOOL_NAMES = new Set(AGENT_TOOL_CATALOG.map((tool) => tool.name));

function isKnownAgentTool(name) {
  return KNOWN_TOOL_NAMES.has(String(name || ''));
}

function listAgentToolCatalog() {
  return AGENT_TOOL_CATALOG.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    agents: [...tool.agents],
  }));
}

function filterEnabledTools(tools, disabledTools = []) {
  const disabled = new Set(
    (Array.isArray(disabledTools) ? disabledTools : [])
      .map((name) => String(name || '').trim())
      .filter(Boolean),
  );
  if (!disabled.size) return Array.isArray(tools) ? tools : [];
  return (tools || []).filter((tool) => !disabled.has(String(tool?.name || '')));
}

module.exports = {
  AGENT_TOOL_CATALOG,
  KNOWN_TOOL_NAMES,
  isKnownAgentTool,
  listAgentToolCatalog,
  filterEnabledTools,
};
