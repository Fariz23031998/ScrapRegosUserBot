const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');

function fromRoot(...parts) {
  return path.join(PROJECT_ROOT, ...parts);
}

function sanitizeAccountLabel(accountLabel) {
  return String(accountLabel || 'account')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'account';
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function authStatePath() {
  return fromRoot('data', 'auth', 'auth-state.json');
}

function easytradeAuthStatePath() {
  return fromRoot('data', 'auth', 'auth-state-easytrade.json');
}

function authStatePathForAccount(accountLabel) {
  return fromRoot('data', 'auth', `auth-state-${sanitizeAccountLabel(accountLabel)}.json`);
}

function rposAuthStatePath(accountLabel) {
  return fromRoot('data', 'auth', `auth-state-rpos-${sanitizeAccountLabel(accountLabel)}.json`);
}

module.exports = {
  PROJECT_ROOT,
  fromRoot,
  sanitizeAccountLabel,
  ensureParentDir,
  envPath: () => fromRoot('.env'),
  dataDir: () => fromRoot('data'),
  dbPath: () => fromRoot('data', 'regos.db'),
  logsDir: () => fromRoot('logs'),
  outputDir: () => fromRoot('output'),
  publicDir: () => fromRoot('public'),
  botAdminPublicDir: () => fromRoot('public', 'bot-admin'),
  brandLogoPath: () => fromRoot('public', 'images', 'brand-logo.png'),
  usersPhonesPath: () => fromRoot('config', 'access', 'users_phones.txt'),
  vipClientsPath: () => fromRoot('config', 'access', 'vip_clients.txt'),
  authStatePath,
  easytradeAuthStatePath,
  authStatePathForAccount,
  rposAuthStatePath,
};
