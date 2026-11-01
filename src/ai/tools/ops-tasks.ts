import type { Unchecked } from '../../types/unchecked';
import { listTaskCategories, listTasks, createTask, updateTask, deleteTask, addTaskDevice, updateTaskDevice, deleteTaskDevice, addTaskService, updateTaskService, deleteTaskService, postTask, unpostTask, advanceTaskStatus } from '../../db/tasks';
import { scheduleTaskAssignmentNotify } from '../../bot/task-assignment-notify';
import { listLocationsForViewer } from '../../db/locations';
import { isRepairReturnRequireSerials } from '../../db/repair-return-settings';
import { listRepairDeviceReturns, createTaskDeviceReturn, deleteTaskDeviceReturn } from '../../db/task-device-returns';
import { factoryToolDescription } from './descriptions';
import { runSafe, compactTask, requireVisibleTask, applyStaffPermissions, hasAnyRight, compactRepairReturn } from './ops-shared';

export function taskOpsTools({ db, userId, viewer, permissions, deps }: Unchecked) {
  return {
  search_tasks: {
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
    execute: async ({ query, status, category_id, location_id, limit }: Unchecked = {}) =>
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
  },
  get_task: {
    name: 'get_task',
    description: factoryToolDescription('get_task'),
    parameters: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
    execute: async ({ id }: Unchecked = {}) =>
      runSafe(async () => {
        const task = await requireVisibleTask(db, id, viewer);
        return task;
      }),
  },
  create_task: {
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
    execute: async (args: any = {}) =>
      runSafe(() => {
        const input = applyStaffPermissions(args, permissions);
        if (!hasAnyRight(permissions, 'tasks_status')) delete input.status;
        const task = createTask(db, input, {
          requireLocation: true,
          viewer,
          actorUserId: userId,
        });
        scheduleTaskAssignmentNotify(db, {
          before: null,
          after: task,
          actorUserId: userId,
        });
        return task;
      }),
  },
  update_task: {
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
    execute: async ({ id, ...args }: Unchecked = {}) =>
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
        const task = updateTask(db, current.id, input, { viewer, actorUserId: userId });
        scheduleTaskAssignmentNotify(db, {
          before: current,
          after: task,
          actorUserId: userId,
        });
        return task;
      }),
  },
  delete_task: {
    name: 'delete_task',
    description: factoryToolDescription('delete_task'),
    parameters: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
    execute: async ({ id }: Unchecked = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, id, viewer);
        const deleted = deleteTask(db, current.id);
        if (!deleted) return { ok: false, error: 'not_found' };
        return { ok: true, id: current.id };
      }),
  },
  add_task_device: {
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
    execute: async ({ task_id, device_id, notes, quantity }: Unchecked = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, task_id, viewer);
        return addTaskDevice(db, current.id, { device_id, notes, quantity });
      }),
  },
  update_task_device: {
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
    execute: async ({ task_id, line_id, quantity }: Unchecked = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, task_id, viewer);
        return updateTaskDevice(db, current.id, line_id, { quantity });
      }),
  },
  delete_task_device: {
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
    execute: async ({ task_id, line_id }: Unchecked = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, task_id, viewer);
        return deleteTaskDevice(db, current.id, line_id);
      }),
  },
  add_task_service: {
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
    execute: async ({ task_id, service_id, notes, quantity }: Unchecked = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, task_id, viewer);
        return addTaskService(db, current.id, { service_id, notes, quantity });
      }),
  },
  update_task_service: {
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
    execute: async ({ task_id, line_id, quantity }: Unchecked = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, task_id, viewer);
        return updateTaskService(db, current.id, line_id, { quantity });
      }),
  },
  delete_task_service: {
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
    execute: async ({ task_id, line_id }: Unchecked = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, task_id, viewer);
        return deleteTaskService(db, current.id, line_id);
      }),
  },
  list_task_categories: {
    name: 'list_task_categories',
    description: factoryToolDescription('list_task_categories'),
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ categories: listTaskCategories(db) }),
  },
  list_task_locations: {
    name: 'list_task_locations',
    description: factoryToolDescription('list_task_locations'),
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ locations: listLocationsForViewer(db, viewer) }),
  },
  advance_task_status: {
    name: 'advance_task_status',
    description: factoryToolDescription('advance_task_status'),
    parameters: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
    execute: async ({ id }: Unchecked = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, id, viewer);
        const task = advanceTaskStatus(db, current.id, viewer, { actorUserId: userId });
        scheduleTaskAssignmentNotify(db, {
          before: current,
          after: task,
          actorUserId: userId,
        });
        return task;
      }),
  },
  post_task: {
    name: 'post_task',
    description: factoryToolDescription('post_task'),
    parameters: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
    execute: async ({ id }: Unchecked = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, id, viewer);
        return postTask(db, current.id, viewer);
      }),
  },
  unpost_task: {
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
    execute: async ({ id, delete_refunds, delete_returns }: Unchecked = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, id, viewer);
        return unpostTask(db, current.id, viewer, {
          deleteRefunds: Boolean(delete_refunds),
          deleteReturns: Boolean(delete_returns),
        });
      }),
  },
  search_repair_returns: {
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
    execute: async ({ query, status, location_id, limit }: Unchecked = {}) =>
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
  },
  create_repair_return: {
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
    execute: async ({ device_line_id, quantity, serial_ids, serial_codes, note }: Unchecked = {}) =>
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
  },
  delete_repair_return: {
    name: 'delete_repair_return',
    description: factoryToolDescription('delete_repair_return'),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Return id (return_id from search_repair_returns status=returned)' },
      },
      required: ['id'],
    },
    execute: async ({ id }: Unchecked = {}) =>
      runSafe(() => {
        const result = deleteTaskDeviceReturn(db, id, viewer);
        return { ok: true, id: Number(id), task: compactTask(result.task) };
      }),
  },
  };
}
