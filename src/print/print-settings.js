const { getSetting, setSetting } = require('../db/app-settings');

const KEY_ENABLED = 'print_gateway_enabled';
const KEY_TOKEN = 'print_gateway_token';
const MAX_TOKEN_LENGTH = 256;
const WS_PATH = '/print-gateway/ws';

function trimValue(value) {
  return String(value == null ? '' : value).trim();
}

function tokenHint(value) {
  const token = trimValue(value);
  if (!token) return '';
  return token.length <= 4 ? token : token.slice(-4);
}

function envForcedOff() {
  return String(process.env.PRINT_GATEWAY_ENABLED || '').trim() === '0';
}

function getStoredToken(db) {
  return trimValue(getSetting(db, KEY_TOKEN, null));
}

function getPrintGatewayToken(db) {
  const stored = getStoredToken(db);
  if (stored) return stored;
  return trimValue(process.env.PRINT_GATEWAY_TOKEN);
}

function getStoredEnabled(db) {
  const raw = getSetting(db, KEY_ENABLED, null);
  if (raw == null || String(raw).trim() === '') return null;
  return String(raw).trim() !== '0';
}

function isPrintGatewayEnabled(db) {
  if (envForcedOff()) return false;
  if (!getPrintGatewayToken(db)) return false;
  const stored = getStoredEnabled(db);
  return stored == null ? true : stored;
}

function getPrintSettingsPublic(db) {
  const token = getPrintGatewayToken(db);
  const stored = getStoredToken(db);
  const envToken = trimValue(process.env.PRINT_GATEWAY_TOKEN);
  let tokenSource = 'none';
  if (stored) tokenSource = 'database';
  else if (envToken) tokenSource = 'env';

  return {
    enabled: isPrintGatewayEnabled(db),
    env_forced_off: envForcedOff(),
    token_configured: Boolean(token),
    token_hint: tokenHint(token),
    token_source: tokenSource,
    ws_path: WS_PATH,
  };
}

function savePrintSettings(db, input = {}) {
  if (Object.prototype.hasOwnProperty.call(input, 'enabled') && input.enabled != null) {
    setSetting(db, KEY_ENABLED, input.enabled ? '1' : '0');
  }

  if (input.clear_token) {
    setSetting(db, KEY_TOKEN, null);
  } else if (Object.prototype.hasOwnProperty.call(input, 'token') && input.token != null) {
    const token = trimValue(input.token);
    if (token.length > MAX_TOKEN_LENGTH) throw new Error('INVALID_PRINT_TOKEN');
    if (token) setSetting(db, KEY_TOKEN, token);
  }

  return getPrintSettingsPublic(db);
}

module.exports = {
  WS_PATH,
  getPrintGatewayToken,
  isPrintGatewayEnabled,
  getPrintSettingsPublic,
  savePrintSettings,
};
