const { getSettings, setSettings } = require('../db/app-settings');

const SECRET_KEYS = {
  openaiApiKey: 'ai_openai_api_key',
  openaiBaseUrl: 'ai_openai_base_url',
  geminiApiKey: 'ai_gemini_api_key',
};

const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const MAX_API_KEY_LENGTH = 512;
const MAX_BASE_URL_LENGTH = 300;

const cache = {
  loaded: false,
  openaiApiKey: '',
  openaiBaseUrl: '',
  geminiApiKey: '',
};

function trimSecret(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeApiKey(value) {
  const key = trimSecret(value);
  if (key.length > MAX_API_KEY_LENGTH) {
    throw new Error('INVALID_AI_API_KEY');
  }
  return key;
}

function normalizeBaseUrl(value) {
  const url = trimSecret(value);
  if (url.length > MAX_BASE_URL_LENGTH) {
    throw new Error('INVALID_AI_BASE_URL');
  }
  return url;
}

function keyHint(value) {
  const key = trimSecret(value);
  if (!key) return '';
  return key.length <= 4 ? key : key.slice(-4);
}

function refreshProviderSecretsCache(db) {
  if (!db) return getStoredProviderSecrets();
  const stored = getSettings(db, Object.values(SECRET_KEYS));
  cache.openaiApiKey = trimSecret(stored[SECRET_KEYS.openaiApiKey]);
  cache.openaiBaseUrl = trimSecret(stored[SECRET_KEYS.openaiBaseUrl]);
  cache.geminiApiKey = trimSecret(stored[SECRET_KEYS.geminiApiKey]);
  cache.loaded = true;
  return getStoredProviderSecrets();
}

function getStoredProviderSecrets() {
  return {
    openaiApiKey: cache.loaded ? cache.openaiApiKey : '',
    openaiBaseUrl: cache.loaded ? cache.openaiBaseUrl : '',
    geminiApiKey: cache.loaded ? cache.geminiApiKey : '',
  };
}

function resolveOpenAiConfig() {
  const stored = getStoredProviderSecrets();
  const apiKey = stored.openaiApiKey || trimSecret(process.env.OPENAI_API_KEY);
  const baseURL = stored.openaiBaseUrl || trimSecret(process.env.OPENAI_BASE_URL) || undefined;
  return { apiKey, baseURL };
}

function resolveGeminiConfig() {
  const stored = getStoredProviderSecrets();
  const apiKey = stored.geminiApiKey || trimSecret(process.env.GEMINI_API_KEY);
  return { apiKey, baseURL: GEMINI_OPENAI_BASE_URL };
}

function saveProviderSecrets(db, patch = {}) {
  const entries = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'openaiApiKey')) {
    entries[SECRET_KEYS.openaiApiKey] = normalizeApiKey(patch.openaiApiKey);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'openaiBaseUrl')) {
    entries[SECRET_KEYS.openaiBaseUrl] = normalizeBaseUrl(patch.openaiBaseUrl);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'geminiApiKey')) {
    entries[SECRET_KEYS.geminiApiKey] = normalizeApiKey(patch.geminiApiKey);
  }
  if (Object.keys(entries).length) {
    setSettings(db, entries);
  }
  return refreshProviderSecretsCache(db);
}

function serializeProviderSecretsStatus() {
  const stored = getStoredProviderSecrets();
  const openai = resolveOpenAiConfig();
  const gemini = resolveGeminiConfig();
  const envOpenAi = trimSecret(process.env.OPENAI_API_KEY);
  const envGemini = trimSecret(process.env.GEMINI_API_KEY);
  return {
    openai_api_key_configured: Boolean(openai.apiKey),
    openai_api_key_hint: keyHint(openai.apiKey),
    openai_api_key_source: stored.openaiApiKey ? 'database' : envOpenAi ? 'env' : 'none',
    openai_base_url: stored.openaiBaseUrl || '',
    gemini_api_key_configured: Boolean(gemini.apiKey),
    gemini_api_key_hint: keyHint(gemini.apiKey),
    gemini_api_key_source: stored.geminiApiKey ? 'database' : envGemini ? 'env' : 'none',
  };
}

module.exports = {
  SECRET_KEYS,
  GEMINI_OPENAI_BASE_URL,
  MAX_API_KEY_LENGTH,
  MAX_BASE_URL_LENGTH,
  refreshProviderSecretsCache,
  getStoredProviderSecrets,
  resolveOpenAiConfig,
  resolveGeminiConfig,
  saveProviderSecrets,
  serializeProviderSecretsStatus,
  keyHint,
};
