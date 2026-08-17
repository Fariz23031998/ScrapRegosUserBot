/** Catalog of toggleable AI agent tools (settings UI + filtering). */

const BROWSE_TOOL_NAMES = new Set(['web_search', 'browse_url']);

const AGENT_TOOL_CATALOG = [
  {
    name: 'search_knowledge',
    title: 'Поиск в базе знаний',
    description:
      'Поиск статей внутренней базы знаний по коротким ключевым словам. Можно ограничить категорией.',
    agents: ['customer', 'customer_assist', 'kb'],
  },
  {
    name: 'get_article',
    title: 'Читать статью',
    description: 'Загрузить полную статью базы знаний по id.',
    agents: ['customer', 'customer_assist', 'kb'],
  },
  {
    name: 'list_knowledge_categories',
    title: 'Список категорий',
    description: 'Показать категории базы знаний (id, название, теги).',
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
    description: 'Создать новую статью в базе знаний и при необходимости назначить категорию.',
    agents: ['kb'],
  },
  {
    name: 'update_article',
    title: 'Обновить статью',
    description: 'Изменить существующую статью базы знаний, в том числе категорию.',
    agents: ['kb'],
  },
  {
    name: 'delete_article',
    title: 'Удалить статью',
    description: 'Удалить статью базы знаний. Заблокированные статьи удалить нельзя.',
    agents: ['kb'],
  },
  {
    name: 'create_category',
    title: 'Создать категорию',
    description: 'Создать категорию базы знаний.',
    agents: ['kb'],
  },
  {
    name: 'update_category',
    title: 'Обновить категорию',
    description: 'Изменить название или теги категории базы знаний.',
    agents: ['kb'],
  },
  {
    name: 'delete_category',
    title: 'Удалить категорию',
    description: 'Удалить категорию. Статьи в ней станут без категории.',
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
    description: 'Найти локальные платёжные заказы по телефону клиента или тексту.',
    agents: ['customer', 'customer_assist'],
  },
  {
    name: 'search_client',
    title: 'Поиск клиента',
    description: 'Найти клиента или фирму в биллинговых порталах по телефону, логину, ИНН или имени.',
    agents: ['customer', 'customer_assist'],
  },
  {
    name: 'get_client_firm',
    title: 'Фирма клиента',
    description: 'Загрузить данные фирмы текущего клиента тикета по его телефону.',
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
    name: 'close_ticket',
    title: 'Закрыть обращение',
    description: 'Закрыть текущее обращение клиента, когда запрос полностью решён.',
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
const TOOL_AGENTS_BY_NAME = new Map(AGENT_TOOL_CATALOG.map((tool) => [tool.name, tool.agents]));
const TOOL_AGENT_SLUGS = ['customer', 'customer_assist', 'kb'];

function isKnownAgentTool(name) {
  return KNOWN_TOOL_NAMES.has(String(name || ''));
}

function isToolAgentSlug(slug) {
  return TOOL_AGENT_SLUGS.includes(String(slug || ''));
}

function agentsForTool(name) {
  return [...(TOOL_AGENTS_BY_NAME.get(String(name || '')) || [])];
}

function toolBelongsToAgent(name, slug) {
  return agentsForTool(name).includes(String(slug || ''));
}

function emptyDisabledAgentTools() {
  return Object.fromEntries(TOOL_AGENT_SLUGS.map((slug) => [slug, []]));
}

function cloneDisabledAgentTools(map) {
  const next = emptyDisabledAgentTools();
  if (!map || typeof map !== 'object' || Array.isArray(map)) return next;
  for (const slug of TOOL_AGENT_SLUGS) {
    next[slug] = Array.isArray(map[slug]) ? [...map[slug]] : [];
  }
  return next;
}

function isDisabledAgentToolsEmpty(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return true;
  return TOOL_AGENT_SLUGS.every((slug) => !Array.isArray(map[slug]) || map[slug].length === 0);
}

function expandDisabledToolsToAgentMap(disabledTools = []) {
  const next = emptyDisabledAgentTools();
  for (const item of Array.isArray(disabledTools) ? disabledTools : []) {
    const name = String(item || '').trim();
    if (!name) continue;
    for (const slug of agentsForTool(name)) {
      if (!isToolAgentSlug(slug) || next[slug].includes(name)) continue;
      next[slug].push(name);
    }
  }
  return next;
}

function deriveFullyDisabledTools(disabledAgentTools, catalog = AGENT_TOOL_CATALOG) {
  const map = cloneDisabledAgentTools(disabledAgentTools);
  const names = [];
  for (const tool of catalog || []) {
    const agents = Array.isArray(tool.agents) ? tool.agents.filter(isToolAgentSlug) : [];
    if (!agents.length) continue;
    const allDisabled = agents.every((slug) => map[slug].includes(tool.name));
    if (allDisabled) names.push(tool.name);
  }
  return names;
}

function listAgentToolCatalog() {
  const { isBrowseEnabled } = require('./browse');
  const browseEnabled = isBrowseEnabled();
  return AGENT_TOOL_CATALOG.filter((tool) => browseEnabled || !BROWSE_TOOL_NAMES.has(tool.name)).map(
    (tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      agents: [...tool.agents],
    }),
  );
}

function namesDisabledForAgent(disabledAgentTools, agentSlug) {
  if (Array.isArray(disabledAgentTools)) {
    return new Set(
      disabledAgentTools.map((name) => String(name || '').trim()).filter(Boolean),
    );
  }
  if (!disabledAgentTools || typeof disabledAgentTools !== 'object') return new Set();
  const slug = String(agentSlug || '').trim();
  const rows = Array.isArray(disabledAgentTools[slug]) ? disabledAgentTools[slug] : [];
  return new Set(rows.map((name) => String(name || '').trim()).filter(Boolean));
}

function filterEnabledTools(tools, disabledAgentTools = [], agentSlug) {
  const disabled = namesDisabledForAgent(disabledAgentTools, agentSlug);
  if (!disabled.size) return Array.isArray(tools) ? tools : [];
  return (tools || []).filter((tool) => !disabled.has(String(tool?.name || '')));
}

function prepareAgentTools(tools, options) {
  return require('../../db/ai-tool-descriptions').prepareAgentTools(tools, options);
}

module.exports = {
  AGENT_TOOL_CATALOG,
  KNOWN_TOOL_NAMES,
  TOOL_AGENT_SLUGS,
  isKnownAgentTool,
  isToolAgentSlug,
  agentsForTool,
  toolBelongsToAgent,
  emptyDisabledAgentTools,
  cloneDisabledAgentTools,
  isDisabledAgentToolsEmpty,
  expandDisabledToolsToAgentMap,
  deriveFullyDisabledTools,
  listAgentToolCatalog,
  filterEnabledTools,
  prepareAgentTools,
};
