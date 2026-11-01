export const AI_SETTING_KEYS = {
  enabled: 'ai_enabled',
  testMode: 'ai_test_mode',
  provider: 'ai_provider',
  model: 'ai_model',
  agentModels: 'ai_agent_models',
  agentMaxSteps: 'ai_agent_max_steps',
  transcribeModel: 'ai_transcribe_model',
  reasoningEffort: 'ai_reasoning_effort',
  historyLimit: 'ai_history_limit',
  customerRepliesPerHour: 'ai_customer_replies_per_hour',
  customerRepliesPerTicket: 'ai_customer_replies_per_ticket',
  groupChatId: 'ai_group_chat_id',
  groupTopics: 'ai_group_topics',
  disabledTools: 'ai_disabled_tools',
  disabledAgentTools: 'ai_disabled_agent_tools',
  defaultAgentTools: 'ai_default_agent_tools',
  ignoredCustomerMessages: 'ai_ignored_customer_messages',
};

export const ALLOWED_PROVIDERS = ['openai', 'gemini'];
export const AGENT_MODEL_SLUGS = ['customer', 'customer_assist', 'kb', 'ops', 'ticket_summary'];
export const SUGGESTED_MODELS_BY_PROVIDER = {
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
export const SUGGESTED_MODELS = [...SUGGESTED_MODELS_BY_PROVIDER.openai];
export const SUGGESTED_TRANSCRIBE_MODELS = ['gpt-4o-transcribe', 'gpt-transcribe', 'whisper-1'];
export const ALLOWED_REASONING_EFFORTS = ['none', 'low', 'medium', 'high'];
export const DEFAULT_PROVIDER = 'openai';
export const DEFAULT_MODEL = 'gpt-4o-mini';
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-transcribe';
export const DEFAULT_REASONING_EFFORT = '';
export const DEFAULT_HISTORY_LIMIT = 30;
export const MIN_HISTORY_LIMIT = 1;
export const MAX_HISTORY_LIMIT = 100;
export const DEFAULT_CUSTOMER_REPLIES_PER_HOUR = 8;
export const DEFAULT_CUSTOMER_REPLIES_PER_TICKET = 20;
export const MIN_CUSTOMER_REPLY_LIMIT = 0;
export const MAX_CUSTOMER_REPLY_LIMIT = 500;
export const DEFAULT_AGENT_MAX_STEPS = 8;
export const MIN_AGENT_MAX_STEPS = 1;
export const MAX_AGENT_MAX_STEPS = 50;
export const MAX_MODEL_LENGTH = 80;
export const MAX_GROUP_TOPICS = 30;
export const MAX_IGNORED_CUSTOMER_MESSAGES = 50;
export const MAX_IGNORED_CUSTOMER_MESSAGE_LENGTH = 200;
export const MAX_TOPIC_KEY_LENGTH = 40;
export const MAX_TOPIC_NAME_LENGTH = 128;
export const MAX_TOPIC_WHEN_LENGTH = 300;
export const TOPIC_KEY_PATTERN = /^[a-z0-9_]+$/;
export const SUMMARY_TOKEN_BUDGET = 2000;
export const SUMMARY_CHARS_PER_TOKEN = 4;
