import type { Unchecked } from '../types/unchecked';
import { findClientByPhone, createClient, getClientById } from '../integrations/regos-crm';

/**
 * Resolve a REGOS CRM client for a Telegram customer.
 * Prefer stored regos_client_id when still valid, then phone match, Client/Add, then fallback.
 *
 * @returns {{ client: object|null, source: 'stored'|'phone'|'created'|'fallback'|'none' }}
 */
async function resolveRegosClient({
  phone,
  displayName,
  settings = {},
  storedClientId = null,
  deps = {},
}: Unchecked = {}) {
  const findByPhone = deps.findClientByPhone || findClientByPhone;
  const create = deps.createClient || createClient;
  const getById = deps.getClientById || getClientById;

  const storedId = Number(storedClientId);
  if (Number.isInteger(storedId) && storedId > 0) {
    try {
      const stored = await getById(storedId);
      if (stored?.id) {
        return { client: stored, source: 'stored' };
      }
    } catch (error: any) {
      console.warn('[regos-client] getClientById(stored) failed:', error?.message || error);
    }
  }

  const match = await findByPhone(phone);
  if (match.status === 'matched' && match.client?.id) {
    return { client: match.client, source: 'phone' };
  }

  try {
    const created = await create({
      name: displayName || phone || 'Клиент Telegram',
      phone: phone || undefined,
    });
    if (created?.id) {
      const client = (await getById(created.id)) || { id: created.id, name: displayName, phone };
      return { client, source: 'created' };
    }
  } catch (error: any) {
    console.warn('[regos-client] Client/Add failed:', error?.message || error);
  }

  const fallbackId = settings.fallbackClientId ?? settings.fallback_client_id ?? null;
  if (fallbackId) {
    try {
      const fallback = await getById(fallbackId);
      if (fallback?.id) {
        return { client: fallback, source: 'fallback' };
      }
    } catch (error: any) {
      console.warn('[regos-client] getClientById(fallback) failed:', error?.message || error);
    }
    return {
      client: { id: Number(fallbackId) },
      source: 'fallback',
    };
  }

  return { client: null, source: 'none' };
}

export { resolveRegosClient };
