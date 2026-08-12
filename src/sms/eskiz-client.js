const { formatPhoneForSms } = require('./sms-message');

const DEFAULT_ESKIZ_BASE_URL = 'https://notify.eskiz.uz';
const DEFAULT_ESKIZ_FROM = '4546';

/** @type {string | null} */
let cachedToken = null;

function getEskizCredentials() {
  return {
    email: process.env.ESKIZ_EMAIL?.trim() || '',
    password: process.env.ESKIZ_PASSWORD?.trim() || '',
  };
}

function getEskizBaseUrl() {
  return (process.env.ESKIZ_BASE_URL?.trim() || DEFAULT_ESKIZ_BASE_URL).replace(/\/$/, '');
}

function getEskizFrom() {
  return process.env.ESKIZ_FROM?.trim() || DEFAULT_ESKIZ_FROM;
}

function isEskizConfigured() {
  const { email, password } = getEskizCredentials();
  return Boolean(email && password);
}

function isEskizEnabled() {
  return process.env.ENABLE_ESKIZ?.trim() === '1' && isEskizConfigured();
}

function clearEskizTokenCache() {
  cachedToken = null;
}

function requireFetch(fetchImpl) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch API is not available');
  }
  return fetchImpl;
}

async function parseJsonResponse(response) {
  const raw = await response.text();
  try {
    return { raw, parsed: JSON.parse(raw) };
  } catch {
    throw new Error(`Eskiz returned invalid JSON (HTTP ${response.status})`);
  }
}

async function login({ fetchImpl = globalThis.fetch } = {}) {
  if (!isEskizConfigured()) {
    throw new Error('ESKIZ_EMAIL and ESKIZ_PASSWORD are required');
  }

  const fetchFn = requireFetch(fetchImpl);
  const { email, password } = getEskizCredentials();
  const form = new FormData();
  form.append('email', email);
  form.append('password', password);

  const response = await fetchFn(`${getEskizBaseUrl()}/api/auth/login`, {
    method: 'POST',
    headers: { 'User-Agent': 'ScrapRegosUserBot/1.0' },
    body: form,
  });

  const { parsed } = await parseJsonResponse(response);
  const token = parsed?.data?.token;
  if (!response.ok || !token) {
    const detail = parsed?.message || parsed?.error || `HTTP ${response.status}`;
    throw new Error(`Eskiz login failed: ${detail}`);
  }

  cachedToken = String(token);
  return cachedToken;
}

async function refreshToken({ fetchImpl = globalThis.fetch } = {}) {
  const fetchFn = requireFetch(fetchImpl);
  if (!cachedToken) {
    return login({ fetchImpl: fetchFn });
  }

  const response = await fetchFn(`${getEskizBaseUrl()}/api/auth/refresh`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${cachedToken}`,
      'User-Agent': 'ScrapRegosUserBot/1.0',
    },
  });

  if (!response.ok) {
    clearEskizTokenCache();
    return login({ fetchImpl: fetchFn });
  }

  const { parsed } = await parseJsonResponse(response);
  const token = parsed?.data?.token;
  if (!token) {
    clearEskizTokenCache();
    return login({ fetchImpl: fetchFn });
  }

  cachedToken = String(token);
  return cachedToken;
}

async function ensureToken({ fetchImpl = globalThis.fetch } = {}) {
  if (cachedToken) return cachedToken;
  return login({ fetchImpl });
}

async function postSendSms(token, { phone, text }, fetchImpl) {
  const form = new FormData();
  form.append('mobile_phone', phone);
  form.append('message', String(text ?? ''));
  form.append('from', getEskizFrom());

  return fetchImpl(`${getEskizBaseUrl()}/api/message/sms/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'ScrapRegosUserBot/1.0',
    },
    body: form,
  });
}

async function sendEskiz({ phone, text }, { fetchImpl = globalThis.fetch } = {}) {
  if (!isEskizConfigured()) {
    throw new Error('ESKIZ_EMAIL and ESKIZ_PASSWORD are required');
  }

  const fetchFn = requireFetch(fetchImpl);
  const formattedPhone = formatPhoneForSms(phone);
  if (!formattedPhone) {
    throw new Error('Invalid SMS recipient phone');
  }

  let token = await ensureToken({ fetchImpl: fetchFn });
  let response = await postSendSms(token, { phone: formattedPhone, text }, fetchFn);

  if (response.status === 401) {
    token = await refreshToken({ fetchImpl: fetchFn });
    response = await postSendSms(token, { phone: formattedPhone, text }, fetchFn);
  }

  const { parsed } = await parseJsonResponse(response);
  if (!response.ok) {
    const detail = parsed?.message || parsed?.error || `HTTP ${response.status}`;
    throw new Error(`Eskiz send failed: ${detail}`);
  }

  const requestId = parsed?.id;
  if (requestId == null || requestId === '') {
    throw new Error('Eskiz response did not include id');
  }

  return {
    requestId,
    recipient: formattedPhone,
  };
}

module.exports = {
  DEFAULT_ESKIZ_BASE_URL,
  DEFAULT_ESKIZ_FROM,
  isEskizConfigured,
  isEskizEnabled,
  clearEskizTokenCache,
  login,
  refreshToken,
  sendEskiz,
};
