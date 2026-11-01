import type { Unchecked } from '../types/unchecked';
import { isKnownAgentTool, toolBelongsToAgent, emptyDisabledAgentTools, emptyDefaultAgentTools, cloneDisabledAgentTools, isDisabledAgentToolsEmpty, expandDisabledToolsToAgentMap } from './tools/catalog';
import { AI_SETTING_KEYS, ALLOWED_PROVIDERS, AGENT_MODEL_SLUGS, SUGGESTED_MODELS, SUGGESTED_MODELS_BY_PROVIDER, SUGGESTED_TRANSCRIBE_MODELS, ALLOWED_REASONING_EFFORTS, DEFAULT_PROVIDER, DEFAULT_MODEL, DEFAULT_GEMINI_MODEL, DEFAULT_TRANSCRIBE_MODEL, DEFAULT_REASONING_EFFORT, DEFAULT_HISTORY_LIMIT, MIN_HISTORY_LIMIT, MAX_HISTORY_LIMIT, DEFAULT_CUSTOMER_REPLIES_PER_HOUR, DEFAULT_CUSTOMER_REPLIES_PER_TICKET, MIN_CUSTOMER_REPLY_LIMIT, MAX_CUSTOMER_REPLY_LIMIT, DEFAULT_AGENT_MAX_STEPS, MIN_AGENT_MAX_STEPS, MAX_AGENT_MAX_STEPS, MAX_MODEL_LENGTH, MAX_GROUP_TOPICS, MAX_IGNORED_CUSTOMER_MESSAGES, MAX_IGNORED_CUSTOMER_MESSAGE_LENGTH, MAX_TOPIC_KEY_LENGTH, MAX_TOPIC_NAME_LENGTH, MAX_TOPIC_WHEN_LENGTH, TOPIC_KEY_PATTERN, SUMMARY_TOKEN_BUDGET, SUMMARY_CHARS_PER_TOKEN } from './settings-constants';

function parseBooleanSetting(value: any, fallback: any = false) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeProvider(value?: any) {
  const provider = String(value || DEFAULT_PROVIDER).trim().toLowerCase();
  if (!ALLOWED_PROVIDERS.includes(provider)) {
    throw new Error('INVALID_AI_PROVIDER');
  }
  return provider;
}

function normalizeModel(value?: any) {
  const model = String(value || DEFAULT_MODEL).trim();
  if (!model || model.length > MAX_MODEL_LENGTH) {
    throw new Error('INVALID_AI_MODEL');
  }
  return model;
}

function normalizeTranscribeModel(value?: any) {
  const model = String(value == null || value === '' ? DEFAULT_TRANSCRIBE_MODEL : value).trim();
  if (!model || model.length > MAX_MODEL_LENGTH) {
    throw new Error('INVALID_AI_TRANSCRIBE_MODEL');
  }
  return model;
}

function normalizeReasoningEffort(value?: any) {
  if (value == null || value === '') return DEFAULT_REASONING_EFFORT;
  const effort = String(value).trim().toLowerCase();
  if (!ALLOWED_REASONING_EFFORTS.includes(effort)) {
    throw new Error('INVALID_AI_REASONING_EFFORT');
  }
  return effort;
}

function isAgentModelSlug(slug?: any) {
  return AGENT_MODEL_SLUGS.includes(String(slug || ''));
}

function emptyAgentModels() {
  return Object.fromEntries(AGENT_MODEL_SLUGS.map((slug?: any) => [slug, '']));
}

function normalizeAgentModels(value?: any) {
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

function parseStoredAgentModels(value?: any) {
  try {
    return normalizeAgentModels(value);
  } catch {
    return emptyAgentModels();
  }
}

function resolveAgentModel(settings?: any, slug?: any) {
  const override = isAgentModelSlug(slug) ? String(settings?.agentModels?.[slug] || '').trim() : '';
  if (override) return override;
  return String(settings?.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

function emptyAgentMaxSteps() {
  return Object.fromEntries(AGENT_MODEL_SLUGS.map((slug?: any) => [slug, '']));
}

function normalizeAgentMaxStepValue(raw?: any) {
  if (raw == null || raw === '') return '';
  const limit = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(limit) || limit < MIN_AGENT_MAX_STEPS || limit > MAX_AGENT_MAX_STEPS) {
    throw new Error('INVALID_AI_AGENT_MAX_STEPS');
  }
  return limit;
}

function normalizeAgentMaxSteps(value?: any) {
  if (value == null || value === '') return emptyAgentMaxSteps();
  let rows = value;
  if (typeof value === 'string') {
    try {
      rows = JSON.parse(value);
    } catch {
      throw new Error('INVALID_AI_AGENT_MAX_STEPS');
    }
  }
  if (typeof rows !== 'object' || Array.isArray(rows)) {
    throw new Error('INVALID_AI_AGENT_MAX_STEPS');
  }
  const next = emptyAgentMaxSteps();
  for (const slug of AGENT_MODEL_SLUGS) {
    next[slug] = normalizeAgentMaxStepValue(rows[slug]);
  }
  return next;
}

function parseStoredAgentMaxSteps(value?: any) {
  try {
    return normalizeAgentMaxSteps(value);
  } catch {
    return emptyAgentMaxSteps();
  }
}

function resolveAgentMaxSteps(settings?: any, slug?: any) {
  if (!isAgentModelSlug(slug)) return DEFAULT_AGENT_MAX_STEPS;
  const raw = settings?.agentMaxSteps?.[slug];
  if (raw == null || raw === '') return DEFAULT_AGENT_MAX_STEPS;
  const limit = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(limit) || limit < MIN_AGENT_MAX_STEPS || limit > MAX_AGENT_MAX_STEPS) {
    return DEFAULT_AGENT_MAX_STEPS;
  }
  return limit;
}

function isReasoningModel(model?: any) {
  const name = String(model || '')
    .trim()
    .toLowerCase();
  return /^(gpt-5|o1|o3)/.test(name);
}

function normalizeHistoryLimit(value: any, fallback: any = DEFAULT_HISTORY_LIMIT) {
  if (value == null || value === '') return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < MIN_HISTORY_LIMIT || limit > MAX_HISTORY_LIMIT) {
    throw new Error('INVALID_AI_HISTORY_LIMIT');
  }
  return limit;
}

function normalizeCustomerReplyLimit(value?: any, fallback?: any) {
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

function parseStoredCustomerReplyLimit(value?: any, fallback?: any) {
  try {
    return normalizeCustomerReplyLimit(value, fallback);
  } catch {
    return fallback;
  }
}

function normalizeGroupChatId(value?: any) {
  const chatId = value == null ? '' : String(value).trim();
  if (!chatId) return '';
  if (!/^-?\d+$/.test(chatId)) {
    throw new Error('INVALID_AI_GROUP_CHAT_ID');
  }
  return chatId;
}

function isBlankGroupTopic(row?: any) {
  if (row == null || typeof row !== 'object') return false;
  const key = String(row.key || '').trim();
  const id = row.id == null || row.id === '' ? '' : String(row.id).trim();
  const name = String(row.name || '').trim();
  const when = String(row.when || '').trim();
  return !key && !id && !name && !when;
}

function normalizeGroupTopic(row?: any) {
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

function normalizeGroupTopics(value?: any) {
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
  const topics = rows.filter((row?: any) => !isBlankGroupTopic(row)).map(normalizeGroupTopic);
  if (topics.length > MAX_GROUP_TOPICS) {
    throw new Error('INVALID_AI_GROUP_TOPICS');
  }
  const seen: Set<any> = new Set();
  for (const topic of topics) {
    if (seen.has(topic.key)) {
      throw new Error('INVALID_AI_GROUP_TOPICS');
    }
    seen.add(topic.key);
  }
  return topics;
}

function parseStoredGroupChatId(value?: any) {
  try {
    return normalizeGroupChatId(value);
  } catch {
    return '';
  }
}

function parseStoredGroupTopics(value?: any) {
  if (value == null || value === '') return [];
  try {
    return normalizeGroupTopics(value);
  } catch {
    return [];
  }
}

function parseStoredTranscribeModel(value?: any) {
  try {
    return normalizeTranscribeModel(value || DEFAULT_TRANSCRIBE_MODEL);
  } catch {
    return DEFAULT_TRANSCRIBE_MODEL;
  }
}

function parseStoredReasoningEffort(value?: any) {
  try {
    return normalizeReasoningEffort(value);
  } catch {
    return DEFAULT_REASONING_EFFORT;
  }
}

function normalizeDisabledTools(value?: any) {
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
  const next: any[] = [];
  const seen: Set<any> = new Set();
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

function parseStoredDisabledTools(value?: any) {
  if (value == null || value === '') return [];
  try {
    return normalizeDisabledTools(value);
  } catch {
    return [];
  }
}

function normalizeDisabledAgentTools(value?: any) {
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
    const seen: Set<any> = new Set();
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

function normalizeDefaultAgentTools(value?: any) {
  if (value == null || value === '') return emptyDefaultAgentTools();
  let rows = value;
  if (typeof value === 'string') {
    try {
      rows = JSON.parse(value);
    } catch {
      throw new Error('INVALID_AI_DEFAULT_TOOLS');
    }
  }
  if (typeof rows !== 'object' || Array.isArray(rows)) {
    throw new Error('INVALID_AI_DEFAULT_TOOLS');
  }
  const next = emptyDefaultAgentTools();
  for (const slug of Object.keys(next)) {
    const list = rows[slug];
    if (list == null || list === '') continue;
    if (!Array.isArray(list)) {
      throw new Error('INVALID_AI_DEFAULT_TOOLS');
    }
    const seen: Set<any> = new Set();
    for (const item of list) {
      const name = String(item || '').trim();
      if (!name || seen.has(name)) continue;
      if (!isKnownAgentTool(name) || !toolBelongsToAgent(name, slug)) {
        throw new Error('INVALID_AI_DEFAULT_TOOLS');
      }
      seen.add(name);
      next[slug].push(name);
    }
  }
  return next;
}

function parseStoredDisabledAgentTools(value?: any) {
  if (value == null || value === '') return emptyDisabledAgentTools();
  try {
    return normalizeDisabledAgentTools(value);
  } catch {
    return emptyDisabledAgentTools();
  }
}

function parseStoredDefaultAgentTools(value?: any) {
  if (value == null || value === '') return emptyDefaultAgentTools();
  try {
    return normalizeDefaultAgentTools(value);
  } catch {
    return emptyDefaultAgentTools();
  }
}

function resolveDisabledAgentTools(disabledAgentTools: any, disabledTools: any = []) {
  if (!isDisabledAgentToolsEmpty(disabledAgentTools)) {
    return cloneDisabledAgentTools(disabledAgentTools);
  }
  return expandDisabledToolsToAgentMap(disabledTools);
}

function normalizeIgnoredCustomerMessages(value?: any) {
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
  const next: any[] = [];
  const seen: Set<any> = new Set();
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

function parseStoredIgnoredCustomerMessages(value?: any) {
  if (value == null || value === '') return [];
  try {
    return normalizeIgnoredCustomerMessages(value);
  } catch {
    return [];
  }
}

function suggestedModelsForProvider(provider?: any) {
  const key = String(provider || DEFAULT_PROVIDER).trim().toLowerCase();
  const models = (SUGGESTED_MODELS_BY_PROVIDER as Record<string, string[]>)[key];
  return models ? [...models] : [...SUGGESTED_MODELS_BY_PROVIDER[DEFAULT_PROVIDER]];
}

export {
  parseBooleanSetting,
  normalizeProvider,
  normalizeModel,
  normalizeTranscribeModel,
  normalizeReasoningEffort,
  isAgentModelSlug,
  emptyAgentModels,
  normalizeAgentModels,
  parseStoredAgentModels,
  resolveAgentModel,
  emptyAgentMaxSteps,
  normalizeAgentMaxStepValue,
  normalizeAgentMaxSteps,
  parseStoredAgentMaxSteps,
  resolveAgentMaxSteps,
  isReasoningModel,
  normalizeHistoryLimit,
  normalizeCustomerReplyLimit,
  parseStoredCustomerReplyLimit,
  normalizeGroupChatId,
  isBlankGroupTopic,
  normalizeGroupTopic,
  normalizeGroupTopics,
  parseStoredGroupChatId,
  parseStoredGroupTopics,
  parseStoredTranscribeModel,
  parseStoredReasoningEffort,
  normalizeDisabledTools,
  parseStoredDisabledTools,
  normalizeDisabledAgentTools,
  normalizeDefaultAgentTools,
  parseStoredDisabledAgentTools,
  parseStoredDefaultAgentTools,
  resolveDisabledAgentTools,
  normalizeIgnoredCustomerMessages,
  parseStoredIgnoredCustomerMessages,
  suggestedModelsForProvider,
};
