const ACCOUNT_NAMES = ['BUKHARA', 'SAMARKAND'];

function getAccountCredentials(name) {
  const phone = process.env[`${name}_REGOS_AUTH_PHONE`];
  const password = process.env[`${name}_REGOS_AUTH_PASSWORD`];

  if (!phone || !password) {
    throw new Error(`Missing credentials for ${name}. Set ${name}_REGOS_AUTH_PHONE and ${name}_REGOS_AUTH_PASSWORD in .env`);
  }

  return { phone, password };
}

function getConfiguredAccounts() {
  return ACCOUNT_NAMES.filter((name) => {
    const phone = process.env[`${name}_REGOS_AUTH_PHONE`];
    const password = process.env[`${name}_REGOS_AUTH_PASSWORD`];
    return Boolean(phone && password);
  });
}

function validateAllAccountsConfigured() {
  const missing = ACCOUNT_NAMES.filter((name) => !getConfiguredAccounts().includes(name));
  if (missing.length > 0) {
    throw new Error(`Missing account credentials in .env for: ${missing.join(', ')}`);
  }
  return ACCOUNT_NAMES;
}

function getRposCredentials(name) {
  const username = process.env[`${name}_RPOS_USERNAME`];
  const password = process.env[`${name}_RPOS_PASSWORD`];
  if (!username || !password) return null;
  return { username, password };
}

function hasRposCredentials(name) {
  return getRposCredentials(name) !== null;
}

module.exports = {
  ACCOUNT_NAMES,
  getAccountCredentials,
  getConfiguredAccounts,
  validateAllAccountsConfigured,
  getRposCredentials,
  hasRposCredentials,
};
