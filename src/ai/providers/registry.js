const providers = {
  openai: () => require('./openai'),
};

function listProviders() {
  return Object.keys(providers);
}

function getProvider(name) {
  const key = String(name || 'openai').trim().toLowerCase();
  const factory = providers[key];
  if (!factory) {
    throw new Error(`UNKNOWN_AI_PROVIDER:${key}`);
  }
  return factory();
}

function registerProvider(name, impl) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) throw new Error('INVALID_AI_PROVIDER');
  providers[key] = typeof impl === 'function' ? impl : () => impl;
}

module.exports = {
  listProviders,
  getProvider,
  registerProvider,
};
