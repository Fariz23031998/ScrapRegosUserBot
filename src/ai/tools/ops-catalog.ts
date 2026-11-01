import type { Unchecked } from '../../types/unchecked';
import { listDevices, getDevice, createDevice, updateDevice, deleteDevice } from '../../db/devices';
import { listServices, getService, createService, updateService, deleteService } from '../../db/services';
import { listCatalogCategories, createCatalogCategory } from '../../db/catalog-categories';
import { factoryToolDescription } from './descriptions';
import { runSafe, parseCategoryFilter, catalogMoneyFromArgs, compactCatalogItem, catalogItemForGet } from './ops-shared';

export function catalogOpsTools({ db, userId, viewer, permissions, deps }: Unchecked) {
  return {
  search_devices: {
    name: 'search_devices',
    description: factoryToolDescription('search_devices'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name or description keywords' },
        category_id: { type: ['number', 'null'], description: 'Optional device category id' },
        limit: { type: 'integer', description: 'Max results (1–100, default 25)' },
      },
    },
    execute: async ({ query, category_id, limit }: Unchecked = {}) =>
      runSafe(() => {
        const parsed = parseCategoryFilter(category_id);
        if (parsed.error) return { ok: false, error: parsed.error };
        const result = listDevices(db, {
          query,
          categoryId: parsed.categoryId,
          limit: limit || 25,
        });
        return {
          query_used: String(query || '').trim(),
          total: result.total,
          devices: result.devices.map(compactCatalogItem),
        };
      }),
  },
  get_device: {
    name: 'get_device',
    description: factoryToolDescription('get_device'),
    parameters: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Device id' } },
      required: ['id'],
    },
    execute: async ({ id }: Unchecked = {}) =>
      runSafe(() => {
        const device = getDevice(db, id);
        return device ? catalogItemForGet(device) : { ok: false, error: 'not_found' };
      }),
  },
  create_device: {
    name: 'create_device',
    description: factoryToolDescription('create_device'),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        category_id: { type: ['number', 'null'] },
        cost_amount: { type: 'number' },
        cost_currency: { type: 'string', description: 'UZS or USD' },
        price_uzs: { type: ['number', 'null'] },
        price_usd: { type: ['number', 'null'] },
        manager_sale_percent: { type: 'number' },
        technician_score: { type: 'number' },
      },
      required: ['name'],
    },
    execute: async (args: any = {}) =>
      runSafe(() => catalogItemForGet(createDevice(db, { ...args, ...catalogMoneyFromArgs(args) }))),
  },
  update_device: {
    name: 'update_device',
    description: factoryToolDescription('update_device'),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        name: { type: 'string' },
        description: { type: 'string' },
        category_id: { type: ['number', 'null'] },
        cost_amount: { type: 'number' },
        cost_currency: { type: 'string' },
        price_uzs: { type: ['number', 'null'] },
        price_usd: { type: ['number', 'null'] },
        manager_sale_percent: { type: 'number' },
        technician_score: { type: 'number' },
      },
      required: ['id'],
    },
    execute: async ({ id, ...args }: Unchecked = {}) =>
      runSafe(() => catalogItemForGet(updateDevice(db, id, { ...args, ...catalogMoneyFromArgs(args) }))),
  },
  delete_device: {
    name: 'delete_device',
    description: factoryToolDescription('delete_device'),
    parameters: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
    execute: async ({ id }: Unchecked = {}) =>
      runSafe(() => {
        const deleted = deleteDevice(db, id);
        if (!deleted) return { ok: false, error: 'not_found' };
        return { ok: true, id: Number(id) };
      }),
  },
  list_device_categories: {
    name: 'list_device_categories',
    description: factoryToolDescription('list_device_categories'),
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ categories: listCatalogCategories(db, 'device') }),
  },
  create_device_category: {
    name: 'create_device_category',
    description: factoryToolDescription('create_device_category'),
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    execute: async ({ name }: Unchecked = {}) => runSafe(() => createCatalogCategory(db, 'device', { name })),
  },
  search_services: {
    name: 'search_services',
    description: factoryToolDescription('search_services'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name or description keywords. Field-work catalog, not the public price list.' },
        category_id: { type: ['number', 'null'] },
        limit: { type: 'integer' },
      },
    },
    execute: async ({ query, category_id, limit }: Unchecked = {}) =>
      runSafe(() => {
        const parsed = parseCategoryFilter(category_id);
        if (parsed.error) return { ok: false, error: parsed.error };
        const result = listServices(db, {
          query,
          categoryId: parsed.categoryId,
          limit: limit || 25,
        });
        return {
          query_used: String(query || '').trim(),
          total: result.total,
          services: result.services.map(compactCatalogItem),
        };
      }),
  },
  get_service: {
    name: 'get_service',
    description: factoryToolDescription('get_service'),
    parameters: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
    execute: async ({ id }: Unchecked = {}) =>
      runSafe(() => {
        const service = getService(db, id);
        return service ? catalogItemForGet(service) : { ok: false, error: 'not_found' };
      }),
  },
  create_service: {
    name: 'create_service',
    description: factoryToolDescription('create_service'),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        category_id: { type: ['number', 'null'] },
        cost_amount: { type: 'number' },
        cost_currency: { type: 'string' },
        price_uzs: { type: ['number', 'null'] },
        price_usd: { type: ['number', 'null'] },
        manager_sale_percent: { type: 'number' },
        technician_score: { type: 'number' },
      },
      required: ['name'],
    },
    execute: async (args: any = {}) =>
      runSafe(() => catalogItemForGet(createService(db, { ...args, ...catalogMoneyFromArgs(args) }))),
  },
  update_service: {
    name: 'update_service',
    description: factoryToolDescription('update_service'),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        name: { type: 'string' },
        description: { type: 'string' },
        category_id: { type: ['number', 'null'] },
        cost_amount: { type: 'number' },
        cost_currency: { type: 'string' },
        price_uzs: { type: ['number', 'null'] },
        price_usd: { type: ['number', 'null'] },
        manager_sale_percent: { type: 'number' },
        technician_score: { type: 'number' },
      },
      required: ['id'],
    },
    execute: async ({ id, ...args }: Unchecked = {}) =>
      runSafe(() => catalogItemForGet(updateService(db, id, { ...args, ...catalogMoneyFromArgs(args) }))),
  },
  delete_service: {
    name: 'delete_service',
    description: factoryToolDescription('delete_service'),
    parameters: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
    execute: async ({ id }: Unchecked = {}) =>
      runSafe(() => {
        const deleted = deleteService(db, id);
        if (!deleted) return { ok: false, error: 'not_found' };
        return { ok: true, id: Number(id) };
      }),
  },
  list_service_categories: {
    name: 'list_service_categories',
    description: factoryToolDescription('list_service_categories'),
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ categories: listCatalogCategories(db, 'service') }),
  },
  create_service_category: {
    name: 'create_service_category',
    description: factoryToolDescription('create_service_category'),
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    execute: async ({ name }: Unchecked = {}) => runSafe(() => createCatalogCategory(db, 'service', { name })),
  },
  };
}
