import type { Unchecked } from '../../types/unchecked';
import { getLocation } from '../../db/locations';
import { listEmployeeUsers } from '../../db/bot-users-db';
import { factoryToolDescription } from './descriptions';
import { runSafe, mapEmployee, mapTaskClient } from './ops-shared';

export function employeeOpsTools({ db, userId, viewer, permissions, deps }: Unchecked) {
  return {
  list_task_employees: {
    name: 'list_task_employees',
    description: factoryToolDescription('list_task_employees'),
    parameters: {
      type: 'object',
      properties: {
        location_id: {
          type: 'number',
          description: 'Branch id from list_task_locations. When set, only employees allowed on that branch.',
        },
      },
    },
    execute: async ({ location_id }: Unchecked = {}) =>
      runSafe(async () => {
        let users = listEmployeeUsers(db);
        if (location_id != null && location_id !== '') {
          const location = getLocation(db, location_id);
          if (!location) throw new Error('INVALID_TASK_LOCATION');
          const allowedIds: Set<any> = new Set(location.allowed_user_ids);
          users = users.filter((user?: any) => allowedIds.has(user.id));
        }
        const employees = users.map(mapEmployee);
        employees.sort((a?: any, b?: any) => a.name.localeCompare(b.name, 'ru'));
        return { employees };
      }),
  },
  search_task_clients: {
    name: 'search_task_clients',
    description: factoryToolDescription('search_task_clients'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'At least 2 characters' },
      },
      required: ['query'],
    },
    execute: async ({ query }: Unchecked = {}) => {
      const text = String(query || '').trim();
      if (text.length < 2) return { clients: [] };
      try {
        const search = deps.searchClients || (require('../../integrations/regos-crm') as typeof import('../../integrations/regos-crm')).searchClients;
        const clients = await search(text, { limit: 20 });
        return { clients: (clients || []).map(mapTaskClient) };
      } catch (error: any) {
        if (error?.name === 'RegosCrmError') {
          return { ok: false, error: error.code || 'regos_error', message: error.message };
        }
        throw error;
      }
    },
  },
  create_task_client: {
    name: 'create_task_client',
    description: factoryToolDescription('create_task_client'),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Client name' },
        phone: { type: 'string', description: 'Client phone' },
        email: { type: 'string', description: 'Optional email' },
        description: { type: 'string', description: 'Optional comment' },
        external_id: { type: 'string', description: 'Optional external id' },
      },
    },
    execute: async ({ name, phone, email, description, external_id }: Unchecked = {}) => {
      try {
        const crm = (require('../../integrations/regos-crm') as typeof import('../../integrations/regos-crm'));
        const create = deps.createClient || crm.createClient;
        const getById = deps.getClientById || crm.getClientById;
        const created = await create({ name, phone, email, description, external_id });
        let fetched: any = null;
        try {
          fetched = await getById(created.id);
        } catch {
          fetched = null;
        }
        return mapTaskClient(
          fetched || {
            id: created.id,
            name: name || null,
            phone: phone || null,
            email: email || null,
          }
        );
      } catch (error: any) {
        if (error?.name === 'RegosCrmError') {
          return { ok: false, error: error.code || 'regos_error', message: error.message };
        }
        throw error;
      }
    },
  },
  };
}
