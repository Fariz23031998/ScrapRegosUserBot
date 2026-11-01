import type { Unchecked } from '../types/unchecked';
import { RegosCrmError, parseRegosCreatedId, postRegosMutation, postClientGet, requirePositiveId } from './regos-crm-http';
import { phonesEqual } from './regos-crm-phones';

async function searchClients(search: any, { limit = 20 }: Unchecked = {}) {
  const query = String(search || '').trim();
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  const page = await postClientGet({
    limit: safeLimit,
    offset: 0,
    ...(query ? { search: query } : {}),
  });
  return page.result;
}

async function getClientById(clientId?: any) {
  const id = requirePositiveId(clientId, 'id');
  const page = await postClientGet({ ids: [id], limit: 1, offset: 0 });
  const client = (page.result || []).find((row?: any) => Number(row?.id) === id);
  return client || null;
}

function normalizeOptionalClientString(value: any, { max, field }: Unchecked = {}) {
  if (value == null) return undefined;
  const text = String(value).trim();
  if (text.length > max) {
    throw new RegosCrmError(`Поле ${field} не должно превышать ${max} символов.`, {
      code: 'BAD_REQUEST',
      status: 400,
    });
  }
  return text;
}

async function editClient(clientId: any, changes: any = {}) {
  const request: Unchecked = { id: requirePositiveId(clientId, 'id') };
  if (Object.hasOwn(changes, 'name')) {
    request.name = normalizeOptionalClientString(changes.name, { max: 200, field: 'name' });
  }
  if (Object.hasOwn(changes, 'phone')) {
    request.phone = normalizeOptionalClientString(changes.phone, { max: 50, field: 'phone' });
  }
  if (Object.hasOwn(changes, 'email')) {
    request.email = normalizeOptionalClientString(changes.email, { max: 150, field: 'email' });
  }
  if (Object.hasOwn(changes, 'description')) {
    request.description = normalizeOptionalClientString(changes.description, {
      max: 4000,
      field: 'description',
    });
  }
  if (Object.hasOwn(changes, 'external_id')) {
    request.external_id = normalizeOptionalClientString(changes.external_id, {
      max: 150,
      field: 'external_id',
    });
  }

  const editableKeys = Object.keys(request).filter((key?: any) => key !== 'id');
  if (editableKeys.length === 0) {
    return { changed: false, result: null };
  }

  const data = await postRegosMutation('Client/Edit', request);
  return { changed: true, result: data.result };
}

/**
 * Create a REGOS CRM client (Client/Add).
 * Returns { id, result }. Throws RegosCrmError when the API rejects the call.
 */
async function createClient(input: any = {}) {
  const request: Unchecked = {};
  const name = normalizeOptionalClientString(input.name, { max: 200, field: 'name' });
  const phone = normalizeOptionalClientString(input.phone, { max: 50, field: 'phone' });
  const email = normalizeOptionalClientString(input.email, { max: 150, field: 'email' });
  const description = normalizeOptionalClientString(input.description, {
    max: 4000,
    field: 'description',
  });
  const externalId = normalizeOptionalClientString(input.external_id, {
    max: 150,
    field: 'external_id',
  });
  if (name !== undefined) request.name = name;
  if (phone !== undefined) request.phone = phone;
  if (email !== undefined) request.email = email;
  if (description !== undefined) request.description = description;
  if (externalId !== undefined) request.external_id = externalId;

  if (!request.name && !request.phone) {
    throw new RegosCrmError('Для создания клиента укажите имя или телефон.', {
      code: 'BAD_REQUEST',
      status: 400,
    });
  }

  const data = await postRegosMutation('Client/Add', request);
  const id = Number(data.result?.new_id ?? data.result?.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new RegosCrmError('REGOS не вернул идентификатор созданного клиента.', {
      code: 'BAD_RESPONSE',
      status: 502,
    });
  }
  return { id, result: data.result };
}

/**
 * Find a unique REGOS client by phone using Client/Get search + phonesEqual.
 * Returns { status: 'matched'|'none'|'ambiguous', client, candidates }.
 */
async function findClientByPhone(phone: any, { limit = 20 }: Unchecked = {}) {
  const query = String(phone || '').trim();
  if (!query) {
    return { status: 'none', client: null, candidates: [] };
  }
  const candidates = (await searchClients(query, { limit })).filter((client?: any) =>
    phonesEqual(client?.phone, query)
  );
  if (candidates.length === 1) {
    return { status: 'matched', client: candidates[0], candidates };
  }
  if (candidates.length === 0) {
    return { status: 'none', client: null, candidates: [] };
  }
  return { status: 'ambiguous', client: null, candidates };
}

export {
  searchClients,
  getClientById,
  editClient,
  createClient,
  findClientByPhone,
};
