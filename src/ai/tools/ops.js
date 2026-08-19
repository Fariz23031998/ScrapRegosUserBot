const {
  listDevices,
  getDevice,
  createDevice,
  updateDevice,
  deleteDevice,
} = require('../../db/devices');
const {
  listServices,
  getService,
  createService,
  updateService,
  deleteService,
} = require('../../db/services');
const {
  listCatalogCategories,
  createCatalogCategory,
} = require('../../db/catalog-categories');
const {
  listTaskCategories,
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  addTaskDevice,
  updateTaskDevice,
  deleteTaskDevice,
  addTaskService,
  updateTaskService,
  deleteTaskService,
  postTask,
  unpostTask,
  advanceTaskStatus,
} = require('../../db/tasks');
const { createTaskPayment, deleteTaskPayment, getTaskPayment } = require('../../db/task-payments');
const { listPaymentTypes } = require('../../db/payment-types');
const { listLocationsForViewer } = require('../../db/locations');
const { listEmployeeUsers } = require('../../db/bot-users-db');
const { isRepairReturnRequireSerials } = require('../../db/repair-return-settings');
const {
  listRepairDeviceReturns,
  createTaskDeviceReturn,
  deleteTaskDeviceReturn,
} = require('../../db/task-device-returns');
const { factoryToolDescription } = require('./descriptions');

const KNOWN_ERROR_CODES = new Set([
  'NOT_FOUND',
  'FORBIDDEN',
  'DEVICE_IN_USE',
  'SERVICE_IN_USE',
  'TASK_CART_LOCKED',
  'TASK_HAS_REFUNDS',
  'TASK_HAS_DEVICE_RETURNS',
  'TASK_NOT_REPAIR',
  'TASK_NOT_DONE',
  'TASK_NOT_POSTED',
  'TASK_RETURN_SERIALS_REQUIRED',
  'INVALID_TASK_STATUS_TRANSITION',
]);

const TOOL_RIGHTS = {
  search_devices: ['devices_read', 'tasks_read'],
  get_device: ['devices_read', 'tasks_read'],
  create_device: ['devices_create'],
  update_device: ['devices_edit'],
  delete_device: ['devices_delete'],
  list_device_categories: ['devices_read', 'tasks_read'],
  create_device_category: ['devices_edit'],
  search_services: ['services_read', 'tasks_read'],
  get_service: ['services_read', 'tasks_read'],
  create_service: ['services_create'],
  update_service: ['services_edit'],
  delete_service: ['services_delete'],
  list_service_categories: ['services_read', 'tasks_read'],
  create_service_category: ['services_edit'],
  search_tasks: ['tasks_read'],
  get_task: ['tasks_read'],
  create_task: ['tasks_create'],
  update_task: ['tasks_edit'],
  delete_task: ['tasks_delete'],
  add_task_device: ['tasks_edit'],
  update_task_device: ['tasks_edit'],
  delete_task_device: ['tasks_edit'],
  add_task_service: ['tasks_edit'],
  update_task_service: ['tasks_edit'],
  delete_task_service: ['tasks_edit'],
  list_task_categories: ['tasks_read'],
  list_task_locations: ['tasks_read'],
  list_task_employees: ['tasks_read'],
  search_task_clients: ['tasks_read'],
  create_task_client: ['tasks_create', 'tasks_edit'],
  list_payment_types: ['tasks_read'],
  advance_task_status: ['tasks_edit'],
  post_task: ['tasks_post'],
  unpost_task: ['tasks_unpost'],
  create_task_payment: ['tasks_payment_create'],
  delete_task_payment: ['tasks_payment_delete'],
  search_repair_returns: ['tasks_read'],
  create_repair_return: ['tasks_edit'],
  delete_repair_return: ['tasks_edit'],
};

const WRITE_TOOL_NAMES = new Set([
  'create_device',
  'update_device',
  'delete_device',
  'create_device_category',
  'create_service',
  'update_service',
  'delete_service',
  'create_service_category',
  'create_task_client',
  'create_task',
  'update_task',
  'delete_task',
  'add_task_device',
  'update_task_device',
  'delete_task_device',
  'add_task_service',
  'update_task_service',
  'delete_task_service',
  'advance_task_status',
  'post_task',
  'unpost_task',
  'create_task_payment',
  'delete_task_payment',
  'create_repair_return',
  'delete_repair_return',
]);

function isKnownError(error) {
  const code = String(error?.message || '');
  return KNOWN_ERROR_CODES.has(code) || code.startsWith('INVALID_');
}

async function runSafe(fn) {
  try {
    return await fn();
  } catch (error) {
    if (isKnownError(error)) return { ok: false, error: error.message };
    throw error;
  }
}

function hasAnyRight(permissions, rights) {
  if (!permissions) return true;
  const needed = Array.isArray(rights) ? rights : [rights];
  return needed.some((right) => Boolean(permissions[right]));
}

function allowTool(name, { write = false, permissions = null } = {}) {
  if (WRITE_TOOL_NAMES.has(name) && !write) return false;
  return hasAnyRight(permissions, TOOL_RIGHTS[name] || []);
}

function parseRequiredId(value, error = 'invalid_id') {
  const id = Number(value);
  if (!Number.isFinite(id) || id <= 0) return { error };
  return id;
}

function parseCategoryFilter(value) {
  if (value === undefined) return { categoryId: undefined };
  if (value === null || value === '' || value === 'all') return { categoryId: undefined };
  if (value === 'none') return { categoryId: null };
  const id = Number(value);
  if (!Number.isFinite(id) || id <= 0) return { error: 'invalid_category' };
  return { categoryId: id };
}

function catalogMoneyFromArgs(args = {}) {
  const money = {};
  if (args.cost_amount !== undefined) money.cost_amount = args.cost_amount;
  if (args.cost_currency !== undefined) money.cost_currency = args.cost_currency;
  if (args.price_uzs !== undefined) money.price_uzs = args.price_uzs;
  if (args.price_usd !== undefined) money.price_usd = args.price_usd;
  if (args.manager_sale_percent !== undefined) money.manager_sale_percent = args.manager_sale_percent;
  if (args.technician_score !== undefined) money.technician_score = args.technician_score;
  return money;
}

function compactCatalogItem(item) {
  if (!item) return null;
  return {
    id: item.id,
    name: item.name,
    description: item.description || '',
    category_id: item.category_id ?? null,
    category: item.category?.name || null,
    cost_amount: item.cost_amount,
    cost_currency: item.cost_currency,
    price_uzs: item.price_uzs,
    price_usd: item.price_usd,
    manager_sale_percent: item.manager_sale_percent,
    technician_score: item.technician_score,
  };
}

function catalogItemForGet(item) {
  if (!item) return null;
  const { images, ...rest } = item;
  return rest;
}

function compactTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    status_label: task.status_label,
    posted: Boolean(task.posted),
    action: task.action,
    action_label: task.action_label,
    client_name: task.client_name || '',
    client_phone: task.client_phone || '',
    location_id: task.location_id ?? null,
    location: task.location?.name || null,
    category_id: task.category_id ?? null,
    category: task.category?.name || null,
    manager: task.manager?.name || null,
    technician: task.technician?.name || null,
    totals: task.totals || null,
    device_count: Array.isArray(task.devices) ? task.devices.length : 0,
    service_count: Array.isArray(task.services) ? task.services.length : 0,
    updated_at: task.updated_at,
  };
}

function employeeLabel(user) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return (
    user.display_name ||
    fullName ||
    user.admin_login ||
    (user.username ? `@${user.username}` : null) ||
    `Сотрудник #${user.id}`
  );
}

function mapEmployee(user) {
  return {
    id: user.id,
    name: employeeLabel(user),
    phone: user.phone || null,
    job_title: user.job_title || null,
  };
}

function mapTaskClient(client) {
  return {
    id: client.id,
    name: client.name || null,
    phone: client.phone || null,
    email: client.email || null,
    external_id: client.external_id || null,
  };
}

function compactPaymentType(item) {
  return {
    id: item.id,
    name: item.name,
    currency: item.currency || item.account?.currency || null,
    account: item.account ? { id: item.account.id, name: item.account.name } : null,
  };
}

function compactSerial(serial) {
  if (!serial) return null;
  return { id: serial.id, code: serial.code };
}

function compactRepairReturn(item) {
  if (!item) return null;
  return {
    kind: item.kind,
    return_id: item.return_id,
    device_line_id: item.device_line_id,
    device_id: item.device_id,
    device_name: item.device_name,
    quantity: item.quantity,
    returned_quantity: item.returned_quantity,
    remaining_quantity: item.remaining_quantity,
    return_quantity: item.return_quantity,
    note: item.note || '',
    created_at: item.created_at,
    created_by: item.created_by?.name || null,
    serials: Array.isArray(item.serials) ? item.serials.map(compactSerial).filter(Boolean) : [],
    task: item.task
      ? {
          id: item.task.id,
          title: item.task.title,
          client_name: item.task.client_name || '',
          client_phone: item.task.client_phone || '',
          location: item.task.location?.name || null,
          technician: item.task.technician?.name || null,
        }
      : null,
  };
}

async function requireVisibleTask(db, taskId, viewer) {
  const parsed = parseRequiredId(taskId, 'INVALID_TASK');
  if (parsed.error) throw new Error(parsed.error);
  const task = getTask(db, parsed, viewer);
  if (!task) throw new Error('NOT_FOUND');
  return task;
}

function applyStaffPermissions(args, permissions, current = null) {
  const next = { ...args };
  const canChangeManager = hasAnyRight(permissions, 'tasks_manager');
  const canChangeTechnician = hasAnyRight(permissions, 'tasks_technician');
  if (!canChangeManager) {
    if (
      current &&
      next.manager_user_id !== undefined &&
      Number(next.manager_user_id || 0) !== Number(current.manager_user_id || 0)
    ) {
      throw new Error('FORBIDDEN');
    }
    delete next.manager_user_id;
  }
  if (!canChangeTechnician) {
    if (
      current &&
      next.technician_user_id !== undefined &&
      Number(next.technician_user_id || 0) !== Number(current.technician_user_id || 0)
    ) {
      throw new Error('FORBIDDEN');
    }
    delete next.technician_user_id;
  }
  return next;
}

function createOpsTools({
  db,
  userId = null,
  viewer = { seeAll: true, userId: null },
  permissions = null,
  write = false,
  deps = {},
} = {}) {
  const options = { write, permissions };
  const tools = [];

  function add(tool) {
    if (!allowTool(tool.name, options)) return;
    tools.push(tool);
  }

  add({
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
    execute: async ({ query, category_id, limit } = {}) =>
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
  });

  add({
    name: 'get_device',
    description: factoryToolDescription('get_device'),
    parameters: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Device id' } },
      required: ['id'],
    },
    execute: async ({ id } = {}) =>
      runSafe(() => {
        const device = getDevice(db, id);
        return device ? catalogItemForGet(device) : { ok: false, error: 'not_found' };
      }),
  });

  add({
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
    execute: async (args = {}) =>
      runSafe(() => catalogItemForGet(createDevice(db, { ...args, ...catalogMoneyFromArgs(args) }))),
  });

  add({
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
    execute: async ({ id, ...args } = {}) =>
      runSafe(() => catalogItemForGet(updateDevice(db, id, { ...args, ...catalogMoneyFromArgs(args) }))),
  });

  add({
    name: 'delete_device',
    description: factoryToolDescription('delete_device'),
    parameters: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
    execute: async ({ id } = {}) =>
      runSafe(() => {
        const deleted = deleteDevice(db, id);
        if (!deleted) return { ok: false, error: 'not_found' };
        return { ok: true, id: Number(id) };
      }),
  });

  add({
    name: 'list_device_categories',
    description: factoryToolDescription('list_device_categories'),
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ categories: listCatalogCategories(db, 'device') }),
  });

  add({
    name: 'create_device_category',
    description: factoryToolDescription('create_device_category'),
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    execute: async ({ name } = {}) => runSafe(() => createCatalogCategory(db, 'device', { name })),
  });

  add({
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
    execute: async ({ query, category_id, limit } = {}) =>
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
  });

  add({
    name: 'get_service',
    description: factoryToolDescription('get_service'),
    parameters: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
    execute: async ({ id } = {}) =>
      runSafe(() => {
        const service = getService(db, id);
        return service ? catalogItemForGet(service) : { ok: false, error: 'not_found' };
      }),
  });

  add({
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
    execute: async (args = {}) =>
      runSafe(() => catalogItemForGet(createService(db, { ...args, ...catalogMoneyFromArgs(args) }))),
  });

  add({
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
    execute: async ({ id, ...args } = {}) =>
      runSafe(() => catalogItemForGet(updateService(db, id, { ...args, ...catalogMoneyFromArgs(args) }))),
  });

  add({
    name: 'delete_service',
    description: factoryToolDescription('delete_service'),
    parameters: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
    execute: async ({ id } = {}) =>
      runSafe(() => {
        const deleted = deleteService(db, id);
        if (!deleted) return { ok: false, error: 'not_found' };
        return { ok: true, id: Number(id) };
      }),
  });

  add({
    name: 'list_service_categories',
    description: factoryToolDescription('list_service_categories'),
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ categories: listCatalogCategories(db, 'service') }),
  });

  add({
    name: 'create_service_category',
    description: factoryToolDescription('create_service_category'),
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    execute: async ({ name } = {}) => runSafe(() => createCatalogCategory(db, 'service', { name })),
  });

  add({
    name: 'search_tasks',
    description: factoryToolDescription('search_tasks'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Title, client, address, notes, device or service name' },
        status: { type: 'string', description: 'new | in_progress | done' },
        category_id: { type: ['number', 'null'] },
        location_id: { type: ['number', 'null'] },
        limit: { type: 'integer' },
      },
    },
    execute: async ({ query, status, category_id, location_id, limit } = {}) =>
      runSafe(() => {
        const result = listTasks(db, {
          query,
          status: status || undefined,
          categoryId: category_id,
          locationId: location_id,
          viewer,
          limit: limit || 25,
        });
        return {
          query_used: String(query || '').trim(),
          total: result.total,
          tasks: result.tasks.map(compactTask),
        };
      }),
  });

  add({
    name: 'get_task',
    description: factoryToolDescription('get_task'),
    parameters: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
    execute: async ({ id } = {}) =>
      runSafe(async () => {
        const task = await requireVisibleTask(db, id, viewer);
        return task;
      }),
  });

  add({
    name: 'create_task',
    description: factoryToolDescription('create_task'),
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        action: { type: 'string', description: 'install | repair | sale' },
        notes: { type: 'string' },
        address: { type: 'string' },
        category_id: { type: ['number', 'null'] },
        location_id: { type: 'number', description: 'Required branch id' },
        regos_client_id: { type: ['number', 'null'] },
        client_name: { type: 'string' },
        client_phone: { type: 'string' },
        manager_user_id: { type: ['number', 'null'] },
        technician_user_id: { type: ['number', 'null'] },
        currency: { type: ['string', 'null'], description: 'UZS | USD | omit' },
        status: { type: 'string', description: 'new | in_progress | done' },
      },
      required: ['title', 'location_id'],
    },
    execute: async (args = {}) =>
      runSafe(() => {
        const input = applyStaffPermissions(args, permissions);
        if (!hasAnyRight(permissions, 'tasks_status')) delete input.status;
        return createTask(db, input, {
          requireLocation: true,
          viewer,
          actorUserId: userId,
        });
      }),
  });

  add({
    name: 'update_task',
    description: factoryToolDescription('update_task'),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        title: { type: 'string' },
        action: { type: 'string' },
        notes: { type: 'string' },
        address: { type: 'string' },
        category_id: { type: ['number', 'null'] },
        location_id: { type: ['number', 'null'] },
        regos_client_id: { type: ['number', 'null'] },
        client_name: { type: 'string' },
        client_phone: { type: 'string' },
        manager_user_id: { type: ['number', 'null'] },
        technician_user_id: { type: ['number', 'null'] },
        currency: { type: ['string', 'null'] },
        status: { type: 'string' },
      },
      required: ['id'],
    },
    execute: async ({ id, ...args } = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, id, viewer);
        const input = applyStaffPermissions(args, permissions, current);
        if (
          input.status != null &&
          String(input.status) !== String(current.status) &&
          !hasAnyRight(permissions, 'tasks_status')
        ) {
          throw new Error('FORBIDDEN');
        }
        if (!hasAnyRight(permissions, 'tasks_status')) delete input.status;
        return updateTask(db, current.id, input, { viewer, actorUserId: userId });
      }),
  });

  add({
    name: 'delete_task',
    description: factoryToolDescription('delete_task'),
    parameters: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
    execute: async ({ id } = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, id, viewer);
        const deleted = deleteTask(db, current.id);
        if (!deleted) return { ok: false, error: 'not_found' };
        return { ok: true, id: current.id };
      }),
  });

  add({
    name: 'add_task_device',
    description: factoryToolDescription('add_task_device'),
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number' },
        device_id: { type: 'number' },
        notes: { type: 'string' },
        quantity: { type: 'integer', description: 'Used only when creating a new line. Existing lines increment by 1.' },
      },
      required: ['task_id', 'device_id'],
    },
    execute: async ({ task_id, device_id, notes, quantity } = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, task_id, viewer);
        return addTaskDevice(db, current.id, { device_id, notes, quantity });
      }),
  });

  add({
    name: 'update_task_device',
    description: factoryToolDescription('update_task_device'),
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number' },
        line_id: { type: 'number' },
        quantity: { type: 'integer' },
      },
      required: ['task_id', 'line_id', 'quantity'],
    },
    execute: async ({ task_id, line_id, quantity } = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, task_id, viewer);
        return updateTaskDevice(db, current.id, line_id, { quantity });
      }),
  });

  add({
    name: 'delete_task_device',
    description: factoryToolDescription('delete_task_device'),
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number' },
        line_id: { type: 'number' },
      },
      required: ['task_id', 'line_id'],
    },
    execute: async ({ task_id, line_id } = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, task_id, viewer);
        return deleteTaskDevice(db, current.id, line_id);
      }),
  });

  add({
    name: 'add_task_service',
    description: factoryToolDescription('add_task_service'),
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number' },
        service_id: { type: 'number' },
        notes: { type: 'string' },
        quantity: { type: 'integer', description: 'Used only when creating a new line. Existing lines increment by 1.' },
      },
      required: ['task_id', 'service_id'],
    },
    execute: async ({ task_id, service_id, notes, quantity } = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, task_id, viewer);
        return addTaskService(db, current.id, { service_id, notes, quantity });
      }),
  });

  add({
    name: 'update_task_service',
    description: factoryToolDescription('update_task_service'),
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number' },
        line_id: { type: 'number' },
        quantity: { type: 'integer' },
      },
      required: ['task_id', 'line_id', 'quantity'],
    },
    execute: async ({ task_id, line_id, quantity } = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, task_id, viewer);
        return updateTaskService(db, current.id, line_id, { quantity });
      }),
  });

  add({
    name: 'delete_task_service',
    description: factoryToolDescription('delete_task_service'),
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number' },
        line_id: { type: 'number' },
      },
      required: ['task_id', 'line_id'],
    },
    execute: async ({ task_id, line_id } = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, task_id, viewer);
        return deleteTaskService(db, current.id, line_id);
      }),
  });

  add({
    name: 'list_task_categories',
    description: factoryToolDescription('list_task_categories'),
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ categories: listTaskCategories(db) }),
  });

  add({
    name: 'list_task_locations',
    description: factoryToolDescription('list_task_locations'),
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ locations: listLocationsForViewer(db, viewer) }),
  });

  add({
    name: 'list_task_employees',
    description: factoryToolDescription('list_task_employees'),
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const employees = listEmployeeUsers(db).map(mapEmployee);
      employees.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      return { employees };
    },
  });

  add({
    name: 'search_task_clients',
    description: factoryToolDescription('search_task_clients'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'At least 2 characters' },
      },
      required: ['query'],
    },
    execute: async ({ query } = {}) => {
      const text = String(query || '').trim();
      if (text.length < 2) return { clients: [] };
      try {
        const search = deps.searchClients || require('../../integrations/regos-crm').searchClients;
        const clients = await search(text, { limit: 20 });
        return { clients: (clients || []).map(mapTaskClient) };
      } catch (error) {
        if (error?.name === 'RegosCrmError') {
          return { ok: false, error: error.code || 'regos_error', message: error.message };
        }
        throw error;
      }
    },
  });

  add({
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
    execute: async ({ name, phone, email, description, external_id } = {}) => {
      try {
        const crm = require('../../integrations/regos-crm');
        const create = deps.createClient || crm.createClient;
        const getById = deps.getClientById || crm.getClientById;
        const created = await create({ name, phone, email, description, external_id });
        let fetched = null;
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
      } catch (error) {
        if (error?.name === 'RegosCrmError') {
          return { ok: false, error: error.code || 'regos_error', message: error.message };
        }
        throw error;
      }
    },
  });

  add({
    name: 'list_payment_types',
    description: factoryToolDescription('list_payment_types'),
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ payment_types: listPaymentTypes(db).map(compactPaymentType) }),
  });

  add({
    name: 'advance_task_status',
    description: factoryToolDescription('advance_task_status'),
    parameters: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
    execute: async ({ id } = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, id, viewer);
        return advanceTaskStatus(db, current.id, viewer, { actorUserId: userId });
      }),
  });

  add({
    name: 'post_task',
    description: factoryToolDescription('post_task'),
    parameters: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
    execute: async ({ id } = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, id, viewer);
        return postTask(db, current.id, viewer);
      }),
  });

  add({
    name: 'unpost_task',
    description: factoryToolDescription('unpost_task'),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        delete_refunds: { type: 'boolean' },
        delete_returns: { type: 'boolean' },
      },
      required: ['id'],
    },
    execute: async ({ id, delete_refunds, delete_returns } = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, id, viewer);
        return unpostTask(db, current.id, viewer, {
          deleteRefunds: Boolean(delete_refunds),
          deleteReturns: Boolean(delete_returns),
        });
      }),
  });

  add({
    name: 'create_task_payment',
    description: factoryToolDescription('create_task_payment'),
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number' },
        payment_type_id: { type: 'number' },
        amount: { type: 'number' },
        currency: { type: 'string', description: 'UZS or USD' },
        note: { type: 'string' },
      },
      required: ['task_id', 'payment_type_id', 'amount'],
    },
    execute: async ({ task_id, payment_type_id, amount, currency, note } = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, task_id, viewer);
        const payment = createTaskPayment(db, current.id, {
          payment_type_id,
          amount,
          currency,
          note,
          created_by_user_id: userId,
        });
        return { payment, task: getTask(db, current.id, viewer) };
      }),
  });

  add({
    name: 'search_repair_returns',
    description: factoryToolDescription('search_repair_returns'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Device, task, client, or location keywords' },
        status: {
          type: 'string',
          description: 'pending (default, still to return), returned, or all',
        },
        location_id: { type: ['number', 'string', 'null'], description: 'Optional branch id' },
        limit: { type: 'integer', description: 'Max results (1–100, default 25)' },
      },
    },
    execute: async ({ query, status, location_id, limit } = {}) =>
      runSafe(() => {
        const result = listRepairDeviceReturns(db, {
          query,
          status: status || 'pending',
          locationId: location_id,
          viewer,
          limit: limit || 25,
        });
        return {
          query_used: String(query || '').trim(),
          status: String(status || 'pending').trim() || 'pending',
          require_serials: isRepairReturnRequireSerials(db),
          total: result.total,
          items: result.items.map(compactRepairReturn),
        };
      }),
  });

  add({
    name: 'create_repair_return',
    description: factoryToolDescription('create_repair_return'),
    parameters: {
      type: 'object',
      properties: {
        device_line_id: {
          type: 'number',
          description: 'Task device line id from search_repair_returns (pending) or get_task',
        },
        quantity: { type: 'integer', description: 'How many to return. Ignored when serials are passed.' },
        serial_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Optional serial ids still on the line',
        },
        serial_codes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional serial codes still on the line',
        },
        note: { type: 'string' },
      },
      required: ['device_line_id'],
    },
    execute: async ({ device_line_id, quantity, serial_ids, serial_codes, note } = {}) =>
      runSafe(() => {
        const result = createTaskDeviceReturn(
          db,
          {
            device_line_id,
            quantity,
            serial_ids,
            serial_codes,
            note,
            created_by_user_id: userId,
          },
          viewer
        );
        return {
          item: compactRepairReturn(result.item),
          task: compactTask(result.task),
        };
      }),
  });

  add({
    name: 'delete_repair_return',
    description: factoryToolDescription('delete_repair_return'),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Return id (return_id from search_repair_returns status=returned)' },
      },
      required: ['id'],
    },
    execute: async ({ id } = {}) =>
      runSafe(() => {
        const result = deleteTaskDeviceReturn(db, id, viewer);
        return { ok: true, id: Number(id), task: compactTask(result.task) };
      }),
  });

  add({
    name: 'delete_task_payment',
    description: factoryToolDescription('delete_task_payment'),
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number' },
        payment_id: { type: 'number' },
      },
      required: ['task_id', 'payment_id'],
    },
    execute: async ({ task_id, payment_id } = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, task_id, viewer);
        const before = getTaskPayment(db, current.id, payment_id);
        if (!before) return { ok: false, error: 'not_found' };
        const deleted = deleteTaskPayment(db, current.id, payment_id);
        if (!deleted) return { ok: false, error: 'not_found' };
        return { ok: true, id: before.id, task: getTask(db, current.id, viewer) };
      }),
  });

  return tools;
}

module.exports = {
  WRITE_TOOL_NAMES,
  TOOL_RIGHTS,
  createOpsTools,
  compactTask,
  compactCatalogItem,
};
