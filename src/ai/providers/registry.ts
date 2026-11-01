const providers: Record<string, () => any> = {
  openai: () => (require('./openai') as typeof import('./openai')),
  gemini: () => (require('./gemini') as typeof import('./gemini')),
};

function listProviders() {
  return Object.keys(providers);
}

function getProvider(name?: any) {
  const key = String(name || 'openai').trim().toLowerCase();
  const factory = providers[key];
  if (!factory) {
    throw new Error(`UNKNOWN_AI_PROVIDER:${key}`);
  }
  return factory();
}

function registerProvider(name?: any, impl?: any) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) throw new Error('INVALID_AI_PROVIDER');
  providers[key] = typeof impl === 'function' ? impl : () => impl;
}

export { listProviders, getProvider, registerProvider };
