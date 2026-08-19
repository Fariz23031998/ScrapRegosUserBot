const { getSettings, setSettings } = require('../db/app-settings');
const {
  refreshProviderSecretsCache,
  saveProviderSecrets,
  serializeProviderSecretsStatus,
} = require('./provider-secrets');
const {
  isKnownAgentTool,
  listAgentToolCatalog,
  toolBelongsToAgent,
  emptyDisabledAgentTools,
  cloneDisabledAgentTools,
  isDisabledAgentToolsEmpty,
  expandDisabledToolsToAgentMap,
  deriveFullyDisabledTools,
} = require('./tools/catalog');

const AI_SETTING_KEYS = {
  enabled: 'ai_enabled',
  testMode: 'ai_test_mode',
  provider: 'ai_provider',
  model: 'ai_model',
  agentModels: 'ai_agent_models',
  transcribeModel: 'ai_transcribe_model',
  reasoningEffort: 'ai_reasoning_effort',
  historyLimit: 'ai_history_limit',
  customerRepliesPerHour: 'ai_customer_replies_per_hour',
  customerRepliesPerTicket: 'ai_customer_replies_per_ticket',
  groupChatId: 'ai_group_chat_id',
  groupTopics: 'ai_group_topics',
  disabledTools: 'ai_disabled_tools',
  disabledAgentTools: 'ai_disabled_agent_tools',
  ignoredCustomerMessages: 'ai_ignored_customer_messages',
};

const ALLOWED_PROVIDERS = ['openai', 'gemini'];
const AGENT_MODEL_SLUGS = ['customer', 'customer_assist', 'kb', 'ops', 'ticket_summary'];
const SUGGESTED_MODELS_BY_PROVIDER = {
  openai: [
    'gpt-5.6',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.2',
    'gpt-5.1',
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
    'gpt-4.1',
    'gpt-4o',
    'gpt-4o-mini',
  ],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'],
};
const SUGGESTED_MODELS = [...SUGGESTED_MODELS_BY_PROVIDER.openai];
const SUGGESTED_TRANSCRIBE_MODELS = ['gpt-4o-transcribe', 'gpt-transcribe', 'whisper-1'];
const ALLOWED_REASONING_EFFORTS = ['none', 'low', 'medium', 'high'];
const DEFAULT_PROVIDER = 'openai';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-transcribe';
const DEFAULT_REASONING_EFFORT = '';
const DEFAULT_HISTORY_LIMIT = 30;
const MIN_HISTORY_LIMIT = 1;
const MAX_HISTORY_LIMIT = 100;
const DEFAULT_CUSTOMER_REPLIES_PER_HOUR = 8;
const DEFAULT_CUSTOMER_REPLIES_PER_TICKET = 20;
const MIN_CUSTOMER_REPLY_LIMIT = 0;
const MAX_CUSTOMER_REPLY_LIMIT = 500;
const MAX_MODEL_LENGTH = 80;
const MAX_GROUP_TOPICS = 30;
const MAX_IGNORED_CUSTOMER_MESSAGES = 50;
const MAX_IGNORED_CUSTOMER_MESSAGE_LENGTH = 200;
const MAX_TOPIC_KEY_LENGTH = 40;
const MAX_TOPIC_NAME_LENGTH = 128;
const MAX_TOPIC_WHEN_LENGTH = 300;
const TOPIC_KEY_PATTERN = /^[a-z0-9_]+$/;
const SUMMARY_TOKEN_BUDGET = 2000;
const SUMMARY_CHARS_PER_TOKEN = 4;

function parseBooleanSetting(value, fallback = false) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeProvider(value) {
  const provider = String(value || DEFAULT_PROVIDER).trim().toLowerCase();
  if (!ALLOWED_PROVIDERS.includes(provider)) {
    throw new Error('INVALID_AI_PROVIDER');
  }
  return provider;
}

function normalizeModel(value) {
  const model = String(value || DEFAULT_MODEL).trim();
  if (!model || model.length > MAX_MODEL_LENGTH) {
    throw new Error('INVALID_AI_MODEL');
  }
  return model;
}

function normalizeTranscribeModel(value) {
  const model = String(value == null || value === '' ? DEFAULT_TRANSCRIBE_MODEL : value).trim();
  if (!model || model.length > MAX_MODEL_LENGTH) {
    throw new Error('INVALID_AI_TRANSCRIBE_MODEL');
  }
  return model;
}

function normalizeReasoningEffort(value) {
  if (value == null || value === '') return DEFAULT_REASONING_EFFORT;
  const effort = String(value).trim().toLowerCase();
  if (!ALLOWED_REASONING_EFFORTS.includes(effort)) {
    throw new Error('INVALID_AI_REASONING_EFFORT');
  }
  return effort;
}

function isAgentModelSlug(slug) {
  return AGENT_MODEL_SLUGS.includes(String(slug || ''));
}

function emptyAgentModels() {
  return Object.fromEntries(AGENT_MODEL_SLUGS.map((slug) => [slug, '']));
}

function normalizeAgentModels(value) {
  if (value == null || value === '') return emptyAgentModels();
  let rows = value;
  if (typeof value === 'string') {
    try {
      rows = JSON.parse(value);
    } catch {
      throw new Error('INVALID_AI_AGENT_MODELS');
    }
  }
  if (typeof rows !== 'object' || Array.isArray(rows)) {
    throw new Error('INVALID_AI_AGENT_MODELS');
  }
  const next = emptyAgentModels();
  for (const slug of AGENT_MODEL_SLUGS) {
    const raw = rows[slug];
    if (raw == null || raw === '') continue;
    next[slug] = normalizeModel(raw);
  }
  return next;
}

function parseStoredAgentModels(value) {
  try {
    return normalizeAgentModels(value);
  } catch {
    return emptyAgentModels();
  }
}

function resolveAgentModel(settings, slug) {
  const override = isAgentModelSlug(slug) ? String(settings?.agentModels?.[slug] || '').trim() : '';
  if (override) return override;
  return String(settings?.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

function isReasoningModel(model) {
  const name = String(model || '')
    .trim()
    .toLowerCase();
  return /^(gpt-5|o1|o3)/.test(name);
}

function normalizeHistoryLimit(value, fallback = DEFAULT_HISTORY_LIMIT) {
  if (value == null || value === '') return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < MIN_HISTORY_LIMIT || limit > MAX_HISTORY_LIMIT) {
    throw new Error('INVALID_AI_HISTORY_LIMIT');
  }
  return limit;
}

function normalizeCustomerReplyLimit(value, fallback) {
  if (value == null || value === '') return fallback;
  const limit = Number(value);
  if (
    !Number.isInteger(limit) ||
    limit < MIN_CUSTOMER_REPLY_LIMIT ||
    limit > MAX_CUSTOMER_REPLY_LIMIT
  ) {
    throw new Error('INVALID_AI_CUSTOMER_REPLY_LIMIT');
  }
  return limit;
}

function parseStoredCustomerReplyLimit(value, fallback) {
  try {
    return normalizeCustomerReplyLimit(value, fallback);
  } catch {
    return fallback;
  }
}

function normalizeGroupChatId(value) {
  const chatId = value == null ? '' : String(value).trim();
  if (!chatId) return '';
  if (!/^-?\d+$/.test(chatId)) {
    throw new Error('INVALID_AI_GROUP_CHAT_ID');
  }
  return chatId;
}

function isBlankGroupTopic(row) {
  if (row == null || typeof row !== 'object') return false;
  const key = String(row.key || '').trim();
  const id = row.id == null || row.id === '' ? '' : String(row.id).trim();
  const name = String(row.name || '').trim();
  const when = String(row.when || '').trim();
  return !key && !id && !name && !when;
}

function normalizeGroupTopic(row) {
  if (row == null || typeof row !== 'object') {
    throw new Error('INVALID_AI_GROUP_TOPICS');
  }
  const key = String(row.key || '').trim().toLowerCase();
  const name = String(row.name || '').trim();
  const when = String(row.when || '').trim();
  const id = Number(row.id);
  if (!key || !TOPIC_KEY_PATTERN.test(key) || key.length > MAX_TOPIC_KEY_LENGTH) {
    throw new Error('INVALID_AI_GROUP_TOPICS');
  }
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('INVALID_AI_GROUP_TOPICS');
  }
  if (!name || name.length > MAX_TOPIC_NAME_LENGTH) {
    throw new Error('INVALID_AI_GROUP_TOPICS');
  }
  if (when.length > MAX_TOPIC_WHEN_LENGTH) {
    throw new Error('INVALID_AI_GROUP_TOPICS');
  }
  return { key, id, name, when };
}

function normalizeGroupTopics(value) {
  if (value == null || value === '') return [];
  let rows = value;
  if (typeof value === 'string') {
    try {
      rows = JSON.parse(value);
    } catch {
      throw new Error('INVALID_AI_GROUP_TOPICS');
    }
  }
  if (!Array.isArray(rows)) {
    throw new Error('INVALID_AI_GROUP_TOPICS');
  }
  const topics = rows.filter((row) => !isBlankGroupTopic(row)).map(normalizeGroupTopic);
  if (topics.length > MAX_GROUP_TOPICS) {
    throw new Error('INVALID_AI_GROUP_TOPICS');
  }
  const seen = new Set();
  for (const topic of topics) {
    if (seen.has(topic.key)) {
      throw new Error('INVALID_AI_GROUP_TOPICS');
    }
    seen.add(topic.key);
  }
  return topics;
}

function parseStoredGroupChatId(value) {
  try {
    return normalizeGroupChatId(value);
  } catch {
    return '';
  }
}

function parseStoredGroupTopics(value) {
  if (value == null || value === '') return [];
  try {
    return normalizeGroupTopics(value);
  } catch {
    return [];
  }
}

function parseStoredTranscribeModel(value) {
  try {
    return normalizeTranscribeModel(value || DEFAULT_TRANSCRIBE_MODEL);
  } catch {
    return DEFAULT_TRANSCRIBE_MODEL;
  }
}

function parseStoredReasoningEffort(value) {
  try {
    return normalizeReasoningEffort(value);
  } catch {
    return DEFAULT_REASONING_EFFORT;
  }
}

function normalizeDisabledTools(value) {
  if (value == null || value === '') return [];
  let rows = value;
  if (typeof value === 'string') {
    try {
      rows = JSON.parse(value);
    } catch {
      throw new Error('INVALID_AI_DISABLED_TOOLS');
    }
  }
  if (!Array.isArray(rows)) {
    throw new Error('INVALID_AI_DISABLED_TOOLS');
  }
  const next = [];
  const seen = new Set();
  for (const item of rows) {
    const name = String(item || '').trim();
    if (!name || seen.has(name)) continue;
    if (!isKnownAgentTool(name)) {
      throw new Error('INVALID_AI_DISABLED_TOOLS');
    }
    seen.add(name);
    next.push(name);
  }
  return next;
}

function parseStoredDisabledTools(value) {
  if (value == null || value === '') return [];
  try {
    return normalizeDisabledTools(value);
  } catch {
    return [];
  }
}

function normalizeDisabledAgentTools(value) {
  if (value == null || value === '') return emptyDisabledAgentTools();
  let rows = value;
  if (typeof value === 'string') {
    try {
      rows = JSON.parse(value);
    } catch {
      throw new Error('INVALID_AI_DISABLED_TOOLS');
    }
  }
  if (Array.isArray(rows)) {
    return expandDisabledToolsToAgentMap(normalizeDisabledTools(rows));
  }
  if (typeof rows !== 'object') {
    throw new Error('INVALID_AI_DISABLED_TOOLS');
  }
  const next = emptyDisabledAgentTools();
  for (const slug of Object.keys(next)) {
    const list = rows[slug];
    if (list == null || list === '') continue;
    if (!Array.isArray(list)) {
      throw new Error('INVALID_AI_DISABLED_TOOLS');
    }
    const seen = new Set();
    for (const item of list) {
      const name = String(item || '').trim();
      if (!name || seen.has(name)) continue;
      if (!isKnownAgentTool(name) || !toolBelongsToAgent(name, slug)) {
        throw new Error('INVALID_AI_DISABLED_TOOLS');
      }
      seen.add(name);
      next[slug].push(name);
    }
  }
  return next;
}

function parseStoredDisabledAgentTools(value) {
  if (value == null || value === '') return emptyDisabledAgentTools();
  try {
    return normalizeDisabledAgentTools(value);
  } catch {
    return emptyDisabledAgentTools();
  }
}

function resolveDisabledAgentTools(disabledAgentTools, disabledTools = []) {
  if (!isDisabledAgentToolsEmpty(disabledAgentTools)) {
    return cloneDisabledAgentTools(disabledAgentTools);
  }
  return expandDisabledToolsToAgentMap(disabledTools);
}

function normalizeIgnoredCustomerMessages(value) {
  if (value == null || value === '') return [];
  let rows = value;
  if (typeof value === 'string') {
    try {
      rows = JSON.parse(value);
    } catch {
      throw new Error('INVALID_AI_IGNORED_CUSTOMER_MESSAGES');
    }
  }
  if (!Array.isArray(rows)) {
    throw new Error('INVALID_AI_IGNORED_CUSTOMER_MESSAGES');
  }
  const next = [];
  const seen = new Set();
  for (const item of rows) {
    const text = String(item || '').trim();
    if (!text) continue;
    if (text.length > MAX_IGNORED_CUSTOMER_MESSAGE_LENGTH) {
      throw new Error('INVALID_AI_IGNORED_CUSTOMER_MESSAGES');
    }
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(text);
  }
  if (next.length > MAX_IGNORED_CUSTOMER_MESSAGES) {
    throw new Error('INVALID_AI_IGNORED_CUSTOMER_MESSAGES');
  }
  return next;
}

function parseStoredIgnoredCustomerMessages(value) {
  if (value == null || value === '') return [];
  try {
    return normalizeIgnoredCustomerMessages(value);
  } catch {
    return [];
  }
}

function suggestedModelsForProvider(provider) {
  const key = String(provider || DEFAULT_PROVIDER).trim().toLowerCase();
  const models = SUGGESTED_MODELS_BY_PROVIDER[key];
  return models ? [...models] : [...SUGGESTED_MODELS_BY_PROVIDER[DEFAULT_PROVIDER]];
}

function loadAiSettings(db) {
  refreshProviderSecretsCache(db);
  const stored = getSettings(db, Object.values(AI_SETTING_KEYS));
  let provider = DEFAULT_PROVIDER;
  try {
    provider = normalizeProvider(stored[AI_SETTING_KEYS.provider] || DEFAULT_PROVIDER);
  } catch {
    provider = DEFAULT_PROVIDER;
  }
  let model = DEFAULT_MODEL;
  try {
    model = normalizeModel(stored[AI_SETTING_KEYS.model] || DEFAULT_MODEL);
  } catch {
    model = DEFAULT_MODEL;
  }
  let historyLimit = DEFAULT_HISTORY_LIMIT;
  try {
    historyLimit = normalizeHistoryLimit(stored[AI_SETTING_KEYS.historyLimit], DEFAULT_HISTORY_LIMIT);
  } catch {
    historyLimit = DEFAULT_HISTORY_LIMIT;
  }
  const customerRepliesPerHour = parseStoredCustomerReplyLimit(
    stored[AI_SETTING_KEYS.customerRepliesPerHour],
    DEFAULT_CUSTOMER_REPLIES_PER_HOUR
  );
  const customerRepliesPerTicket = parseStoredCustomerReplyLimit(
    stored[AI_SETTING_KEYS.customerRepliesPerTicket],
    DEFAULT_CUSTOMER_REPLIES_PER_TICKET
  );
  const disabledAgentTools = resolveDisabledAgentTools(
    parseStoredDisabledAgentTools(stored[AI_SETTING_KEYS.disabledAgentTools]),
    parseStoredDisabledTools(stored[AI_SETTING_KEYS.disabledTools]),
  );
  return {
    enabled: parseBooleanSetting(stored[AI_SETTING_KEYS.enabled], false),
    testMode: parseBooleanSetting(stored[AI_SETTING_KEYS.testMode], false),
    provider,
    model,
    agentModels: parseStoredAgentModels(stored[AI_SETTING_KEYS.agentModels]),
    transcribeModel: parseStoredTranscribeModel(stored[AI_SETTING_KEYS.transcribeModel]),
    reasoningEffort: parseStoredReasoningEffort(stored[AI_SETTING_KEYS.reasoningEffort]),
    historyLimit,
    customerRepliesPerHour,
    customerRepliesPerTicket,
    groupChatId: parseStoredGroupChatId(stored[AI_SETTING_KEYS.groupChatId]),
    groupTopics: parseStoredGroupTopics(stored[AI_SETTING_KEYS.groupTopics]),
    disabledAgentTools,
    disabledTools: deriveFullyDisabledTools(disabledAgentTools),
    ignoredCustomerMessages: parseStoredIgnoredCustomerMessages(
      stored[AI_SETTING_KEYS.ignoredCustomerMessages]
    ),
  };
}

function disabledToolsFromMap(disabledAgentTools) {
  return deriveFullyDisabledTools(disabledAgentTools);
}

function saveAiSettings(db, patch = {}) {
  const current = loadAiSettings(db);
  const next = {
    enabled: patch.enabled != null ? Boolean(patch.enabled) : current.enabled,
    testMode: patch.testMode != null ? Boolean(patch.testMode) : current.testMode,
    provider: patch.provider != null ? normalizeProvider(patch.provider) : current.provider,
    model: patch.model != null ? normalizeModel(patch.model) : current.model,
    agentModels:
      patch.agentModels != null ? normalizeAgentModels(patch.agentModels) : current.agentModels,
    transcribeModel:
      patch.transcribeModel != null
        ? normalizeTranscribeModel(patch.transcribeModel)
        : current.transcribeModel,
    reasoningEffort:
      patch.reasoningEffort != null
        ? normalizeReasoningEffort(patch.reasoningEffort)
        : current.reasoningEffort,
    historyLimit:
      patch.historyLimit != null ? normalizeHistoryLimit(patch.historyLimit) : current.historyLimit,
    customerRepliesPerHour:
      patch.customerRepliesPerHour != null
        ? normalizeCustomerReplyLimit(patch.customerRepliesPerHour)
        : current.customerRepliesPerHour,
    customerRepliesPerTicket:
      patch.customerRepliesPerTicket != null
        ? normalizeCustomerReplyLimit(patch.customerRepliesPerTicket)
        : current.customerRepliesPerTicket,
    groupChatId:
      patch.groupChatId != null ? normalizeGroupChatId(patch.groupChatId) : current.groupChatId,
    groupTopics:
      patch.groupTopics != null ? normalizeGroupTopics(patch.groupTopics) : current.groupTopics,
    disabledAgentTools:
      patch.disabledAgentTools != null
        ? normalizeDisabledAgentTools(patch.disabledAgentTools)
        : patch.disabledTools != null
          ? expandDisabledToolsToAgentMap(normalizeDisabledTools(patch.disabledTools))
          : current.disabledAgentTools,
    ignoredCustomerMessages:
      patch.ignoredCustomerMessages != null
        ? normalizeIgnoredCustomerMessages(patch.ignoredCustomerMessages)
        : current.ignoredCustomerMessages,
  };
  next.disabledTools = disabledToolsFromMap(next.disabledAgentTools);
  setSettings(db, {
    [AI_SETTING_KEYS.enabled]: next.enabled ? '1' : '0',
    [AI_SETTING_KEYS.testMode]: next.testMode ? '1' : '0',
    [AI_SETTING_KEYS.provider]: next.provider,
    [AI_SETTING_KEYS.model]: next.model,
    [AI_SETTING_KEYS.agentModels]: JSON.stringify(next.agentModels),
    [AI_SETTING_KEYS.transcribeModel]: next.transcribeModel,
    [AI_SETTING_KEYS.reasoningEffort]: next.reasoningEffort,
    [AI_SETTING_KEYS.historyLimit]: String(next.historyLimit),
    [AI_SETTING_KEYS.customerRepliesPerHour]: String(next.customerRepliesPerHour),
    [AI_SETTING_KEYS.customerRepliesPerTicket]: String(next.customerRepliesPerTicket),
    [AI_SETTING_KEYS.groupChatId]: next.groupChatId,
    [AI_SETTING_KEYS.groupTopics]: JSON.stringify(next.groupTopics),
    [AI_SETTING_KEYS.disabledTools]: JSON.stringify(next.disabledTools),
    [AI_SETTING_KEYS.disabledAgentTools]: JSON.stringify(next.disabledAgentTools),
    [AI_SETTING_KEYS.ignoredCustomerMessages]: JSON.stringify(next.ignoredCustomerMessages),
  });

  const secretPatch = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'openaiApiKey')) {
    secretPatch.openaiApiKey = patch.openaiApiKey;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'openaiBaseUrl')) {
    secretPatch.openaiBaseUrl = patch.openaiBaseUrl;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'geminiApiKey')) {
    secretPatch.geminiApiKey = patch.geminiApiKey;
  }
  if (Object.keys(secretPatch).length) {
    saveProviderSecrets(db, secretPatch);
  } else {
    refreshProviderSecretsCache(db);
  }

  return loadAiSettings(db);
}

function serializeAiSettings(settings) {
  const disabledAgentTools = cloneDisabledAgentTools(settings.disabledAgentTools);
  const disabledTools = disabledToolsFromMap(disabledAgentTools);
  const provider = settings.provider || DEFAULT_PROVIDER;
  const modelsByProvider = Object.fromEntries(
    ALLOWED_PROVIDERS.map((name) => [name, suggestedModelsForProvider(name)])
  );
  return {
    enabled: Boolean(settings.enabled),
    test_mode: Boolean(settings.testMode),
    provider,
    model: settings.model,
    agent_models: { ...emptyAgentModels(), ...(settings.agentModels || {}) },
    transcribe_model: settings.transcribeModel || DEFAULT_TRANSCRIBE_MODEL,
    reasoning_effort: settings.reasoningEffort || '',
    history_limit: Number(settings.historyLimit) || DEFAULT_HISTORY_LIMIT,
    customer_replies_per_hour: Number.isInteger(settings.customerRepliesPerHour)
      ? settings.customerRepliesPerHour
      : DEFAULT_CUSTOMER_REPLIES_PER_HOUR,
    customer_replies_per_ticket: Number.isInteger(settings.customerRepliesPerTicket)
      ? settings.customerRepliesPerTicket
      : DEFAULT_CUSTOMER_REPLIES_PER_TICKET,
    group_chat_id: settings.groupChatId || '',
    group_topics: (settings.groupTopics || []).map((topic) => ({
      key: topic.key,
      id: topic.id,
      name: topic.name,
      when: topic.when || '',
    })),
    disabled_tools: [...disabledTools],
    disabled_agent_tools: disabledAgentTools,
    ignored_customer_messages: Array.isArray(settings.ignoredCustomerMessages)
      ? [...settings.ignoredCustomerMessages]
      : [],
    agent_tools: listAgentToolCatalog().map((tool) => {
      const enabled_agents = Object.fromEntries(
        (tool.agents || []).map((slug) => [
          slug,
          !(disabledAgentTools[slug] || []).includes(tool.name),
        ]),
      );
      const enabled =
        (tool.agents || []).length > 0 &&
        (tool.agents || []).every((slug) => enabled_agents[slug]);
      return {
        ...tool,
        enabled,
        enabled_agents,
      };
    }),
    providers: [...ALLOWED_PROVIDERS],
    models: suggestedModelsForProvider(provider),
    models_by_provider: modelsByProvider,
    transcribe_models: [...SUGGESTED_TRANSCRIBE_MODELS],
    reasoning_efforts: [...ALLOWED_REASONING_EFFORTS],
    agent_model_slugs: [...AGENT_MODEL_SLUGS],
    history_limit_min: MIN_HISTORY_LIMIT,
    history_limit_max: MAX_HISTORY_LIMIT,
    customer_replies_per_hour_min: MIN_CUSTOMER_REPLY_LIMIT,
    customer_replies_per_hour_max: MAX_CUSTOMER_REPLY_LIMIT,
    customer_replies_per_ticket_min: MIN_CUSTOMER_REPLY_LIMIT,
    customer_replies_per_ticket_max: MAX_CUSTOMER_REPLY_LIMIT,
    group_topics_max: MAX_GROUP_TOPICS,
    ignored_customer_messages_max: MAX_IGNORED_CUSTOMER_MESSAGES,
    ...serializeProviderSecretsStatus(),
  };
}

module.exports = {
  AI_SETTING_KEYS,
  ALLOWED_PROVIDERS,
  AGENT_MODEL_SLUGS,
  SUGGESTED_MODELS,
  SUGGESTED_MODELS_BY_PROVIDER,
  SUGGESTED_TRANSCRIBE_MODELS,
  ALLOWED_REASONING_EFFORTS,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_TRANSCRIBE_MODEL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_HISTORY_LIMIT,
  MIN_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  DEFAULT_CUSTOMER_REPLIES_PER_HOUR,
  DEFAULT_CUSTOMER_REPLIES_PER_TICKET,
  MIN_CUSTOMER_REPLY_LIMIT,
  MAX_CUSTOMER_REPLY_LIMIT,
  MAX_GROUP_TOPICS,
  MAX_IGNORED_CUSTOMER_MESSAGES,
  MAX_IGNORED_CUSTOMER_MESSAGE_LENGTH,
  SUMMARY_TOKEN_BUDGET,
  SUMMARY_CHARS_PER_TOKEN,
  parseBooleanSetting,
  normalizeProvider,
  normalizeModel,
  normalizeTranscribeModel,
  normalizeReasoningEffort,
  normalizeAgentModels,
  resolveAgentModel,
  isReasoningModel,
  isAgentModelSlug,
  suggestedModelsForProvider,
  normalizeHistoryLimit,
  normalizeCustomerReplyLimit,
  normalizeGroupChatId,
  normalizeGroupTopics,
  normalizeDisabledTools,
  normalizeDisabledAgentTools,
  resolveDisabledAgentTools,
  normalizeIgnoredCustomerMessages,
  loadAiSettings,
  saveAiSettings,
  serializeAiSettings,
};
