import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = path.join(__dirname, '..');

function fromRoot(...parts: any[]) {
  return path.join(PROJECT_ROOT, ...parts);
}

function sanitizeAccountLabel(accountLabel?: any) {
  return String(accountLabel || 'account')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'account';
}

function ensureParentDir(filePath?: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function authStatePath() {
  return fromRoot('data', 'auth', 'auth-state.json');
}

function easytradeAuthStatePath() {
  return fromRoot('data', 'auth', 'auth-state-easytrade.json');
}

function authStatePathForAccount(accountLabel?: any) {
  return fromRoot('data', 'auth', `auth-state-${sanitizeAccountLabel(accountLabel)}.json`);
}

function rposAuthStatePath(accountLabel?: any) {
  return fromRoot('data', 'auth', `auth-state-rpos-${sanitizeAccountLabel(accountLabel)}.json`);
}

const envPath = () => fromRoot('.env');
const dataDir = () => fromRoot('data');
const dbPath = () => fromRoot('data', 'regos.db');
const logsDir = () => fromRoot('logs');
const outputDir = () => fromRoot('output');
const publicDir = () => fromRoot('public');
const botAdminPublicDir = () => fromRoot('public', 'bot-admin');
const botAdminUiDistDir = () => fromRoot('bot-admin-ui', 'dist');
const brandLogoPath = () => fromRoot('public', 'images', 'brand-logo.png');
const usersPhonesPath = () => fromRoot('config', 'access', 'users_phones.txt');
const vipClientsPath = () => fromRoot('config', 'access', 'vip_clients.txt');

function sanitizePathId(value?: any) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return '0';
  return String(n);
}

function ticketVideoRoot() {
  const override = String(process.env.TICKET_VIDEO_DIR || '').trim();
  if (override) return path.resolve(override);
  return fromRoot('data', 'ticket-video');
}

function ticketVideoDir(ticketId?: any, fileId?: any) {
  return path.join(ticketVideoRoot(), sanitizePathId(ticketId), sanitizePathId(fileId));
}

function ticketVideoFramePath(ticketId?: any, fileId?: any, filename?: any) {
  const name = String(filename || '').trim() || 'frame.jpg';
  return path.join(ticketVideoDir(ticketId, fileId), path.basename(name));
}

export {
  PROJECT_ROOT,
  fromRoot,
  sanitizeAccountLabel,
  ensureParentDir,
  envPath,
  dataDir,
  dbPath,
  logsDir,
  outputDir,
  publicDir,
  botAdminPublicDir,
  botAdminUiDistDir,
  brandLogoPath,
  usersPhonesPath,
  vipClientsPath,
  authStatePath,
  easytradeAuthStatePath,
  authStatePathForAccount,
  rposAuthStatePath,
  ticketVideoRoot,
  ticketVideoDir,
  ticketVideoFramePath,
};
