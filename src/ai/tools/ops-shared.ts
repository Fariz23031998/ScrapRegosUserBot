import type { Unchecked } from '../../types/unchecked';
import type { Db } from '../../types/db';
import { getTask } from '../../db/tasks';

const KNOWN_ERROR_CODES: Set<any> = new Set([
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

function isKnownError(error: Error) {
  const code = String(error?.message || '');
  return KNOWN_ERROR_CODES.has(code) || code.startsWith('INVALID_');
}

async function runSafe(fn?: any) {
  try {
    return await fn();
  } catch (error: any) {
    if (isKnownError(error)) return { ok: false, error: error.message };
    throw error;
  }
}

function hasAnyRight(permissions?: any, rights?: any) {
  if (!permissions) return true;
  const needed = Array.isArray(rights) ? rights : [rights];
  return needed.some((right?: any) => Boolean(permissions[right]));
}

function parseRequiredId(value: any, error: string = 'invalid_id') {
  const id = Number(value);
  if (!Number.isFinite(id) || id <= 0) return { error };
  return id;
}

function parseCategoryFilter(value?: any) {
  if (value === undefined) return { categoryId: undefined };
  if (value === null || value === '' || value === 'all') return { categoryId: undefined };
  if (value === 'none') return { categoryId: null };
  const id = Number(value);
  if (!Number.isFinite(id) || id <= 0) return { error: 'invalid_category' };
  return { categoryId: id };
}

function catalogMoneyFromArgs(args: any = {}) {
  const money: Unchecked = {};
  if (args.cost_amount !== undefined) money.cost_amount = args.cost_amount;
  if (args.cost_currency !== undefined) money.cost_currency = args.cost_currency;
  if (args.price_uzs !== undefined) money.price_uzs = args.price_uzs;
  if (args.price_usd !== undefined) money.price_usd = args.price_usd;
  if (args.manager_sale_percent !== undefined) money.manager_sale_percent = args.manager_sale_percent;
  if (args.technician_score !== undefined) money.technician_score = args.technician_score;
  return money;
}

function compactCatalogItem(item?: any) {
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

function catalogItemForGet(item?: any) {
  if (!item) return null;
  const { images, ...rest } = item;
  return rest;
}

function compactTask(task?: any) {
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

function employeeLabel(user?: any) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return (
    user.display_name ||
    fullName ||
    user.admin_login ||
    (user.username ? `@${user.username}` : null) ||
    `Сотрудник #${user.id}`
  );
}

function mapEmployee(user?: any) {
  return {
    id: user.id,
    name: employeeLabel(user),
    phone: user.phone || null,
    job_title: user.job_title || null,
  };
}

function mapTaskClient(client?: any) {
  return {
    id: client.id,
    name: client.name || null,
    phone: client.phone || null,
    email: client.email || null,
    external_id: client.external_id || null,
  };
}

function compactPaymentType(item?: any) {
  return {
    id: item.id,
    name: item.name,
    currency: item.currency || item.account?.currency || null,
    account: item.account ? { id: item.account.id, name: item.account.name } : null,
  };
}

function compactSerial(serial?: any) {
  if (!serial) return null;
  return { id: serial.id, code: serial.code };
}

function compactRepairReturn(item?: any) {
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

async function requireVisibleTask(db: Db, taskId?: any, viewer?: any) {
  const parsed = parseRequiredId(taskId, 'INVALID_TASK');
  if (typeof parsed !== 'number') throw new Error(parsed.error);
  const task = getTask(db, parsed, viewer);
  if (!task) throw new Error('NOT_FOUND');
  return task;
}

function applyStaffPermissions(args: any, permissions: any, current: any = null) {
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

export {
  runSafe,
  hasAnyRight,
  parseRequiredId,
  parseCategoryFilter,
  catalogMoneyFromArgs,
  compactCatalogItem,
  catalogItemForGet,
  compactTask,
  mapEmployee,
  mapTaskClient,
  compactPaymentType,
  compactRepairReturn,
  requireVisibleTask,
  applyStaffPermissions,
};
