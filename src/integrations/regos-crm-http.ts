import type { Unchecked } from '../types/unchecked';
const DEFAULT_API_TARGET = 'https://integration.regos.uz';
const PAGE_LIMIT = 100;
class RegosCrmError extends Error {
  constructor(message: any, { code = 'REGOS_ERROR', status = 502 }: Unchecked = {}) {
    super(message);
    this.name = 'RegosCrmError';
    this.code = code;
    this.status = status;
  }
}

function getIntegrationToken() {
  const token = String(process.env.REGOS_INTEGRATION_TOKEN || '').trim();
  if (!token) {
    throw new RegosCrmError(
      'REGOS_INTEGRATION_TOKEN не задан. Укажите токен в .env и перезапустите сервер.',
      { code: 'TOKEN_MISSING', status: 503 }
    );
  }
  return token;
}

function getApiTarget() {
  const base = String(process.env.REGOS_API_TARGET || '').trim();
  return (base || DEFAULT_API_TARGET).replace(/\/$/, '');
}

function buildHeaders() {
  const headers: Unchecked = {
    'Content-Type': 'application/json;charset=utf-8',
  };
  const bearer = String(process.env.REGOS_BEARER_TOKEN || '').trim();
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  }
  return headers;
}

async function postRegosRaw(endpoint?: any, request?: any) {
  const token = getIntegrationToken();
  const url = `${getApiTarget()}/gateway/out/${token}/v1/${endpoint}`;

  let response: any;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(request ?? {}),
    });
  } catch (error: any) {
    throw new RegosCrmError(
      `Не удалось связаться с REGOS API: ${error.message || error}`,
      { code: 'NETWORK', status: 502 }
    );
  }

  if (!response.ok) {
    throw new RegosCrmError(`REGOS API вернул код статуса ${response.status}`, {
      code: 'HTTP_STATUS',
      status: 502,
    });
  }

  const data = await response.json().catch(() => ({}));

  if (!data.ok) {
    const err = data.result && typeof data.result === 'object' ? data.result : {};
    const code = err.error || 'Unknown';
    const desc = err.description || 'Unknown error';
    throw new RegosCrmError(`Ошибка REGOS API: ${code} - ${desc}`, {
      code: 'API_ERROR',
      status: 502,
    });
  }

  return data;
}

async function postRegos(endpoint?: any, request?: any) {
  const data = await postRegosRaw(endpoint, request);

  if (!Array.isArray(data.result)) {
    throw new RegosCrmError(
      `Некорректный ответ REGOS API ${endpoint}: ожидался массив`,
      { code: 'BAD_RESPONSE', status: 502 }
    );
  }

  return {
    ok: true,
    result: data.result,
    next_offset: data.next_offset ?? 0,
    total: data.total ?? data.result.length,
  };
}

function parseRegosCreatedId(result?: any) {
  if (!result || typeof result !== 'object') return null;
  const raw = result.new_id ?? result.id ?? result.message_id;
  if (raw == null || raw === '') return null;
  return String(raw);
}
async function postRegosMutation(endpoint?: any, request?: any) {
  const data = await postRegosRaw(endpoint, request);

  if (data.result == null || typeof data.result !== 'object' || Array.isArray(data.result)) {
    throw new RegosCrmError(
      `Некорректный ответ REGOS API ${endpoint}: ожидался объект`,
      { code: 'BAD_RESPONSE', status: 502 }
    );
  }

  return {
    ok: true,
    result: data.result,
  };
}

async function postTicketGet(request?: any) {
  return postRegos('Ticket/Get', request);
}

async function postUserGet(request: any = {}) {
  return postRegos('User/Get', request);
}

async function postChannelGet(request: any = {}) {
  return postRegos('Channel/Get', request);
}

async function postClientGet(request: any = {}) {
  return postRegos('Client/Get', request);
}

async function postChatGet(request: any = {}) {
  return postRegos('Chat/Get', request);
}

async function postChatMessageGet(request: any = {}) {
  return postRegos('ChatMessage/Get', request);
}

function requirePositiveId(value?: any, field?: any) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new RegosCrmError(`Поле ${field} должно быть положительным целым числом.`, {
      code: 'BAD_REQUEST',
      status: 400,
    });
  }
  return id;
}

export {
  RegosCrmError,
  PAGE_LIMIT,
  parseRegosCreatedId,
  postRegos,
  postRegosMutation,
  requirePositiveId,
  postTicketGet,
  postUserGet,
  postChannelGet,
  postClientGet,
  postChatGet,
  postChatMessageGet,
};
