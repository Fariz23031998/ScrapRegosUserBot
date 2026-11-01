import type { Unchecked } from '../../types/unchecked';
import { hasAnyRight, compactTask, compactCatalogItem } from './ops-shared';
import { catalogOpsTools } from './ops-catalog';
import { taskOpsTools } from './ops-tasks';
import { paymentOpsTools } from './ops-payments';
import { employeeOpsTools } from './ops-employees';

const TOOL_RIGHTS: Record<string, string[]> = {
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

const WRITE_TOOL_NAMES: Set<any> = new Set([
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

function allowTool(name: any, { write = false, permissions = null }: Unchecked = {}) {
  if (WRITE_TOOL_NAMES.has(name) && !write) return false;
  return hasAnyRight(permissions, TOOL_RIGHTS[name as string] || []);
}

function createOpsTools({
  db,
  userId = null,
  viewer = { seeAll: true, userId: null },
  permissions = null,
  write = false,
  deps = {},
}: Unchecked = {}) {
  const options = { write, permissions };
  const ctx = { db, userId, viewer, permissions, deps };
  const catalog = catalogOpsTools(ctx);
  const tasks = taskOpsTools(ctx);
  const payments = paymentOpsTools(ctx);
  const employees = employeeOpsTools(ctx);
  const ordered: any[] = [
    catalog.search_devices,
    catalog.get_device,
    catalog.create_device,
    catalog.update_device,
    catalog.delete_device,
    catalog.list_device_categories,
    catalog.create_device_category,
    catalog.search_services,
    catalog.get_service,
    catalog.create_service,
    catalog.update_service,
    catalog.delete_service,
    catalog.list_service_categories,
    catalog.create_service_category,
    tasks.search_tasks,
    tasks.get_task,
    tasks.create_task,
    tasks.update_task,
    tasks.delete_task,
    tasks.add_task_device,
    tasks.update_task_device,
    tasks.delete_task_device,
    tasks.add_task_service,
    tasks.update_task_service,
    tasks.delete_task_service,
    tasks.list_task_categories,
    tasks.list_task_locations,
    employees.list_task_employees,
    employees.search_task_clients,
    employees.create_task_client,
    payments.list_payment_types,
    tasks.advance_task_status,
    tasks.post_task,
    tasks.unpost_task,
    payments.create_task_payment,
    tasks.search_repair_returns,
    tasks.create_repair_return,
    tasks.delete_repair_return,
    payments.delete_task_payment,
  ];
  return ordered.filter((tool) => allowTool(tool.name, options));
}

export {
  WRITE_TOOL_NAMES,
  TOOL_RIGHTS,
  createOpsTools,
  compactTask,
  compactCatalogItem,
};
