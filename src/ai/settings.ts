import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { getSettings, setSettings } from '../db/app-settings';
import { refreshProviderSecretsCache, saveProviderSecrets, serializeProviderSecretsStatus } from './provider-secrets';
import { listAgentToolCatalog, cloneDisabledAgentTools, deriveFullyDisabledTools, resolveDefaultAgentTools, expandDisabledToolsToAgentMap } from './tools/catalog';
import { AI_SETTING_KEYS, ALLOWED_PROVIDERS, AGENT_MODEL_SLUGS, SUGGESTED_MODELS, SUGGESTED_MODELS_BY_PROVIDER, SUGGESTED_TRANSCRIBE_MODELS, ALLOWED_REASONING_EFFORTS, DEFAULT_PROVIDER, DEFAULT_MODEL, DEFAULT_GEMINI_MODEL, DEFAULT_TRANSCRIBE_MODEL, DEFAULT_REASONING_EFFORT, DEFAULT_HISTORY_LIMIT, MIN_HISTORY_LIMIT, MAX_HISTORY_LIMIT, DEFAULT_CUSTOMER_REPLIES_PER_HOUR, DEFAULT_CUSTOMER_REPLIES_PER_TICKET, MIN_CUSTOMER_REPLY_LIMIT, MAX_CUSTOMER_REPLY_LIMIT, DEFAULT_AGENT_MAX_STEPS, MIN_AGENT_MAX_STEPS, MAX_AGENT_MAX_STEPS, MAX_GROUP_TOPICS, MAX_IGNORED_CUSTOMER_MESSAGES, MAX_IGNORED_CUSTOMER_MESSAGE_LENGTH, SUMMARY_TOKEN_BUDGET, SUMMARY_CHARS_PER_TOKEN } from './settings-constants';
import { parseBooleanSetting, normalizeProvider, normalizeModel, normalizeTranscribeModel, normalizeReasoningEffort, normalizeAgentModels, resolveAgentModel, normalizeAgentMaxSteps, resolveAgentMaxSteps, isReasoningModel, isAgentModelSlug, suggestedModelsForProvider, normalizeHistoryLimit, normalizeCustomerReplyLimit, normalizeGroupChatId, normalizeGroupTopics, normalizeDisabledTools, normalizeDisabledAgentTools, normalizeDefaultAgentTools, resolveDisabledAgentTools, normalizeIgnoredCustomerMessages, emptyAgentModels, emptyAgentMaxSteps, parseStoredAgentModels, parseStoredAgentMaxSteps, parseStoredCustomerReplyLimit, parseStoredGroupChatId, parseStoredGroupTopics, parseStoredTranscribeModel, parseStoredReasoningEffort, parseStoredDisabledTools, parseStoredDisabledAgentTools, parseStoredDefaultAgentTools, parseStoredIgnoredCustomerMessages } from './settings-normalize';

function loadAiSettings(db: Db) {
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
  const defaultAgentTools = resolveDefaultAgentTools(
    parseStoredDefaultAgentTools(stored[AI_SETTING_KEYS.defaultAgentTools]),
  );
  return {
    enabled: parseBooleanSetting(stored[AI_SETTING_KEYS.enabled], false),
    testMode: parseBooleanSetting(stored[AI_SETTING_KEYS.testMode], false),
    provider,
    model,
    agentModels: parseStoredAgentModels(stored[AI_SETTING_KEYS.agentModels]),
    agentMaxSteps: parseStoredAgentMaxSteps(stored[AI_SETTING_KEYS.agentMaxSteps]),
    transcribeModel: parseStoredTranscribeModel(stored[AI_SETTING_KEYS.transcribeModel]),
    reasoningEffort: parseStoredReasoningEffort(stored[AI_SETTING_KEYS.reasoningEffort]),
    historyLimit,
    customerRepliesPerHour,
    customerRepliesPerTicket,
    groupChatId: parseStoredGroupChatId(stored[AI_SETTING_KEYS.groupChatId]),
    groupTopics: parseStoredGroupTopics(stored[AI_SETTING_KEYS.groupTopics]),
    disabledAgentTools,
    disabledTools: deriveFullyDisabledTools(disabledAgentTools),
    defaultAgentTools,
    ignoredCustomerMessages: parseStoredIgnoredCustomerMessages(
      stored[AI_SETTING_KEYS.ignoredCustomerMessages]
    ),
  };
}

function disabledToolsFromMap(disabledAgentTools?: any) {
  return deriveFullyDisabledTools(disabledAgentTools);
}

function saveAiSettings(db: Db, patch: any = {}) {
  const current = loadAiSettings(db);
  const next: Unchecked = {
    enabled: patch.enabled != null ? Boolean(patch.enabled) : current.enabled,
    testMode: patch.testMode != null ? Boolean(patch.testMode) : current.testMode,
    provider: patch.provider != null ? normalizeProvider(patch.provider) : current.provider,
    model: patch.model != null ? normalizeModel(patch.model) : current.model,
    agentModels:
      patch.agentModels != null ? normalizeAgentModels(patch.agentModels) : current.agentModels,
    agentMaxSteps:
      patch.agentMaxSteps != null
        ? normalizeAgentMaxSteps(patch.agentMaxSteps)
        : current.agentMaxSteps,
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
    defaultAgentTools:
      patch.defaultAgentTools != null
        ? normalizeDefaultAgentTools(patch.defaultAgentTools)
        : current.defaultAgentTools,
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
    [AI_SETTING_KEYS.agentMaxSteps]: JSON.stringify(next.agentMaxSteps),
    [AI_SETTING_KEYS.transcribeModel]: next.transcribeModel,
    [AI_SETTING_KEYS.reasoningEffort]: next.reasoningEffort,
    [AI_SETTING_KEYS.historyLimit]: String(next.historyLimit),
    [AI_SETTING_KEYS.customerRepliesPerHour]: String(next.customerRepliesPerHour),
    [AI_SETTING_KEYS.customerRepliesPerTicket]: String(next.customerRepliesPerTicket),
    [AI_SETTING_KEYS.groupChatId]: next.groupChatId,
    [AI_SETTING_KEYS.groupTopics]: JSON.stringify(next.groupTopics),
    [AI_SETTING_KEYS.disabledTools]: JSON.stringify(next.disabledTools),
    [AI_SETTING_KEYS.disabledAgentTools]: JSON.stringify(next.disabledAgentTools),
    [AI_SETTING_KEYS.defaultAgentTools]: JSON.stringify(next.defaultAgentTools),
    [AI_SETTING_KEYS.ignoredCustomerMessages]: JSON.stringify(next.ignoredCustomerMessages),
  });

  const secretPatch: Unchecked = {};
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

function serializeAiSettings(settings?: any) {
  const disabledAgentTools = cloneDisabledAgentTools(settings.disabledAgentTools);
  const disabledTools = disabledToolsFromMap(disabledAgentTools);
  const defaultAgentTools = resolveDefaultAgentTools(settings.defaultAgentTools);
  const provider = settings.provider || DEFAULT_PROVIDER;
  const modelsByProvider = Object.fromEntries(
    ALLOWED_PROVIDERS.map((name?: any) => [name, suggestedModelsForProvider(name)])
  );
  return {
    enabled: Boolean(settings.enabled),
    test_mode: Boolean(settings.testMode),
    provider,
    model: settings.model,
    agent_models: { ...emptyAgentModels(), ...(settings.agentModels || {}) },
    agent_max_steps: { ...emptyAgentMaxSteps(), ...(settings.agentMaxSteps || {}) },
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
    group_topics: (settings.groupTopics || []).map((topic?: any) => ({
      key: topic.key,
      id: topic.id,
      name: topic.name,
      when: topic.when || '',
    })),
    disabled_tools: [...disabledTools],
    disabled_agent_tools: disabledAgentTools,
    default_agent_tools: defaultAgentTools,
    ignored_customer_messages: Array.isArray(settings.ignoredCustomerMessages)
      ? [...settings.ignoredCustomerMessages]
      : [],
    agent_tools: listAgentToolCatalog().map((tool?: any) => {
      const enabled_agents = Object.fromEntries(
        (tool.agents || []).map((slug?: any) => [
          slug,
          !(disabledAgentTools[slug] || []).includes(tool.name),
        ]),
      );
      const default_agents = (tool.agents || []).filter((slug?: any) =>
        (defaultAgentTools[slug] || []).includes(tool.name),
      );
      const enabled =
        (tool.agents || []).length > 0 &&
        (tool.agents || []).every((slug?: any) => enabled_agents[slug]);
      return {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        agents: [...(tool.agents || [])],
        default_agents,
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
    agent_max_steps_min: MIN_AGENT_MAX_STEPS,
    agent_max_steps_max: MAX_AGENT_MAX_STEPS,
    agent_max_steps_default: DEFAULT_AGENT_MAX_STEPS,
    customer_replies_per_hour_min: MIN_CUSTOMER_REPLY_LIMIT,
    customer_replies_per_hour_max: MAX_CUSTOMER_REPLY_LIMIT,
    customer_replies_per_ticket_min: MIN_CUSTOMER_REPLY_LIMIT,
    customer_replies_per_ticket_max: MAX_CUSTOMER_REPLY_LIMIT,
    group_topics_max: MAX_GROUP_TOPICS,
    ignored_customer_messages_max: MAX_IGNORED_CUSTOMER_MESSAGES,
    ...serializeProviderSecretsStatus(),
  };
}

export {
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
  DEFAULT_AGENT_MAX_STEPS,
  MIN_AGENT_MAX_STEPS,
  MAX_AGENT_MAX_STEPS,
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
  normalizeAgentMaxSteps,
  resolveAgentMaxSteps,
  isReasoningModel,
  isAgentModelSlug,
  suggestedModelsForProvider,
  normalizeHistoryLimit,
  normalizeCustomerReplyLimit,
  normalizeGroupChatId,
  normalizeGroupTopics,
  normalizeDisabledTools,
  normalizeDisabledAgentTools,
  normalizeDefaultAgentTools,
  resolveDisabledAgentTools,
  resolveDefaultAgentTools,
  normalizeIgnoredCustomerMessages,
  loadAiSettings,
  saveAiSettings,
  serializeAiSettings,
};
