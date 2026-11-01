import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { getDevice } from './devices';
import { getService } from './services';
import { getBotUserById } from './bot-users-db';
import { CURRENCIES, roundMoney, snapshotMoney, emptyLineMoneySnapshot } from './money';
import { getLocation, canViewerAccessLocation, userCanAccessLocation } from './locations';
import { tableExists } from './tasks-schema';
import { getTaskCategory } from './tasks-categories';

const MAX_TITLE = 200;
const MAX_NOTES = 5000;
const MAX_ADDRESS = 2000;

const MAX_CLIENT_NAME = 200;
const MAX_CLIENT_PHONE = 40;
const MAX_LINE_NOTES = 500;
const MAX_LINE_QUANTITY = 999;
const TASK_STATUSES = ['new', 'in_progress', 'done'];
const TASK_STATUS_ORDER = { new: 0, in_progress: 1, done: 2 };
const TASK_ACTIONS = ['install', 'repair', 'sale'];
const TASK_STATUS_LABELS = {
  new: 'Новая',
  in_progress: 'В работе',
  done: 'Выполнена',
};
const TASK_ACTION_LABELS = {
  install: 'Установка',
  repair: 'Ремонт',
  sale: 'Продажа',
};

function normalizeOptionalText(value?: any, max?: any, errorCode?: any) {
  if (value == null) return null;
  const text = String(value).trim();
  if (text.length > max) throw new Error(errorCode);
  return text || null;
}

function normalizeOptionalNonNegative(value?: any, errorCode?: any) {
  if (value === undefined) return undefined;
  if (value == null || value === '') return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(errorCode);
  return roundMoney(amount);
}

function normalizeOptionalId(value?: any) {
  if (value == null || value === '' || value === 0 || value === '0') return null;
  const id = Number(value);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

function normalizeCategoryId(db: Db, value?: any) {
  if (value === undefined) return undefined;
  const categoryId = normalizeOptionalId(value);
  if (categoryId == null) return null;
  const category = getTaskCategory(db, categoryId);
  if (!category) throw new Error('INVALID_TASK_CATEGORY');
  return category.id;
}

function normalizeLocationId(db: Db, value: any, { required = false, viewer }: Unchecked = {}) {
  if (value === undefined && !required) return undefined;
  const locationId = normalizeOptionalId(value);
  if (locationId == null) {
    if (required) throw new Error('INVALID_TASK_LOCATION');
    return null;
  }
  const location = getLocation(db, locationId);
  if (!location) throw new Error('INVALID_TASK_LOCATION');
  if (!canViewerAccessLocation(db, location.id, viewer)) {
    throw new Error('INVALID_TASK_LOCATION');
  }
  return location.id;
}

function normalizeEmployeeId(db: Db, value?: any, errorCode?: any) {
  if (value === undefined) return undefined;
  const userId = normalizeOptionalId(value);
  if (userId == null) return null;
  const user = getBotUserById(db, userId);
  if (!user || user.role !== 'employee') throw new Error(errorCode);
  return user.id;
}

function resolveEmployeeId(db: Db, value?: any) {
  try {
    return normalizeEmployeeId(db, value, 'INVALID_TASK_EMPLOYEE') ?? null;
  } catch {
    return null;
  }
}

function isManagerAssignableAction(action?: any) {
  return action === 'install' || action === 'repair' || action === 'sale';
}

function isTechnicianAssignableAction(action?: any) {
  return action === 'install' || action === 'repair';
}

function shouldAssignTechnicianOnStatus(action?: any, status?: any) {
  return isTechnicianAssignableAction(action) && (status === 'in_progress' || status === 'done');
}

function sameStaffId(left?: any, right?: any) {
  const a = left == null || left === '' ? null : Number(left);
  const b = right == null || right === '' ? null : Number(right);
  if (a == null && b == null) return true;
  return a === b;
}

function shouldResetTechnicianReminder(current: any, next: any) {
  if (!current) return false;
  return (
    !sameStaffId(current.technician_user_id, next.technician_user_id) ||
    String(current.planned_start_at || '') !== String(next.planned_start_at || '')
  );
}

function staffAllowedOnLocation(db: Db, locationId?: any, userId?: any) {
  if (locationId == null || locationId === '') return true;
  if (userId == null) return true;
  return userCanAccessLocation(db, locationId, userId);
}

function assertStaffOnLocation(db: Db, locationId?: any, userId?: any, errorCode?: any) {
  if (locationId == null || userId == null) return;
  if (!userCanAccessLocation(db, locationId, userId)) throw new Error(errorCode);
}

function applyCreateStaffAssignment(db: Db, input?: any, actorUserId?: any) {
  const next = { ...input };
  const action = next.action != null && next.action !== '' ? String(next.action).trim() : 'install';
  if (!isManagerAssignableAction(action)) return next;
  const hasManager = next.manager_user_id != null && next.manager_user_id !== '';
  if (hasManager) return next;
  const employeeId = resolveEmployeeId(db, actorUserId);
  if (employeeId && staffAllowedOnLocation(db, next.location_id, employeeId)) {
    next.manager_user_id = employeeId;
  }
  return next;
}

function normalizeStatus(value: any, fallback: any = 'new') {
  if (value == null || value === '') return fallback;
  const status = String(value).trim();
  if (!TASK_STATUSES.includes(status)) throw new Error('INVALID_TASK_STATUS');
  return status;
}

function nextTaskStatus(status?: any) {
  if (status === 'new') return 'in_progress';
  if (status === 'in_progress') return 'done';
  return null;
}

function assertForwardStatus(currentStatus?: any, nextStatus?: any) {
  if (currentStatus === nextStatus) return;
  const currentOrder = TASK_STATUS_ORDER[currentStatus as keyof typeof TASK_STATUS_ORDER];
  const nextOrder = TASK_STATUS_ORDER[nextStatus as keyof typeof TASK_STATUS_ORDER];
  if (
    currentOrder == null ||
    nextOrder == null ||
    nextOrder !== currentOrder + 1
  ) {
    throw new Error('INVALID_TASK_STATUS_TRANSITION');
  }
}

function isTaskCartLocked(task?: any) {
  return Boolean(task && task.posted);
}

function assertTaskCartEditable(task?: any) {
  if (isTaskCartLocked(task)) throw new Error('TASK_CART_LOCKED');
}

function countTaskRefunds(db: Db, taskId?: any) {
  if (!tableExists(db, 'task_refunds')) return 0;
  const row = db.prepare('SELECT COUNT(*) AS count FROM task_refunds WHERE task_id = ?').get(taskId);
  return Number(row?.count) || 0;
}

function normalizeAction(value: any, fallback: any = 'install') {
  if (value == null || value === '') return fallback;
  const action = String(value).trim();
  if (!TASK_ACTIONS.includes(action)) throw new Error('INVALID_TASK_ACTION');
  return action;
}

function normalizeDisplayCurrency(value: any, fallback: any = null) {
  if (value === undefined) return fallback;
  if (value == null || value === '') return null;
  const currency = String(value).trim().toUpperCase();
  if (!CURRENCIES.includes(currency)) throw new Error('INVALID_TASK_CURRENCY');
  return currency;
}

function normalizePlannedAt(value?: any) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const date = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(raw)
    ? new Date(`${raw.replace(' ', 'T')}Z`)
    : new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error('INVALID_TASK_PLAN');
  return date.toISOString();
}

function normalizeQuantity(value: any, fallback: any = 1) {
  if (value == null || value === '') return fallback;
  const qty = Number(value);
  if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty < 1 || qty > MAX_LINE_QUANTITY) {
    throw new Error('INVALID_TASK_QUANTITY');
  }
  return qty;
}

function normalizeTaskDeviceLine(db: Db, item: any, index: any = 0, fallbackAction: any = 'install') {
  const device = getDevice(db, item?.device_id);
  if (!device) throw new Error('INVALID_TASK_DEVICE');
  const action = normalizeAction(item?.action, fallbackAction);
  const notes = normalizeOptionalText(item?.notes, MAX_LINE_NOTES, 'INVALID_TASK_DEVICE_NOTES');
  const quantity = normalizeQuantity(item?.quantity);
  return {
    device_id: device.id,
    action,
    notes,
    quantity,
    sort_order: index,
    ...(fallbackAction === 'repair' ? emptyLineMoneySnapshot() : snapshotMoney(device)),
  };
}

function normalizeTaskServiceLine(db: Db, item: any, index: any = 0) {
  const service = getService(db, item?.service_id);
  if (!service) throw new Error('INVALID_TASK_SERVICE');
  const notes = normalizeOptionalText(item?.notes, MAX_LINE_NOTES, 'INVALID_TASK_SERVICE_NOTES');
  const quantity = normalizeQuantity(item?.quantity);
  return {
    service_id: service.id,
    notes,
    quantity,
    sort_order: index,
    ...snapshotMoney(service),
  };
}

function normalizeTaskDevices(db: Db, devices: any, fallbackAction: any = 'install') {
  if (devices == null) return [];
  if (!Array.isArray(devices)) throw new Error('INVALID_TASK_DEVICES');
  return devices.map((item?: any, index?: any) => normalizeTaskDeviceLine(db, item, index, fallbackAction));
}

function normalizeTaskInput(db: Db, input: any = {}, { partial = false, current = null, requireLocation = false, viewer }: Unchecked = {}) {
  const titleSource = input.title != null ? input.title : current?.title;
  const title = String(titleSource || '').trim();
  if (!partial || input.title != null) {
    if (!title || title.length > MAX_TITLE) throw new Error('INVALID_TASK_TITLE');
  }
  const status = normalizeStatus(
    input.status != null ? input.status : current?.status,
    current?.status || 'new'
  );
  const action = normalizeAction(
    input.action != null ? input.action : current?.action,
    current?.action || 'install'
  );
  const notes = normalizeOptionalText(
    input.notes != null ? input.notes : current?.notes,
    MAX_NOTES,
    'INVALID_TASK_NOTES'
  );
  const address = normalizeOptionalText(
    input.address != null ? input.address : current?.address,
    MAX_ADDRESS,
    'INVALID_TASK_ADDRESS'
  );
  const distanceKm = input.distance_km !== undefined
    ? normalizeOptionalNonNegative(input.distance_km, 'INVALID_TASK_DISTANCE')
    : current?.distance_km ?? null;
  const distanceScore = input.distance_score !== undefined
    ? normalizeOptionalNonNegative(input.distance_score, 'INVALID_TASK_DISTANCE_SCORE')
    : current?.distance_score ?? null;
  const clientName = normalizeOptionalText(
    input.client_name != null ? input.client_name : current?.client_name,
    MAX_CLIENT_NAME,
    'INVALID_TASK_CLIENT'
  );
  const clientPhone = normalizeOptionalText(
    input.client_phone != null ? input.client_phone : current?.client_phone,
    MAX_CLIENT_PHONE,
    'INVALID_TASK_CLIENT'
  );
  let regosClientId = current?.regos_client_id ?? null;
  if (input.regos_client_id !== undefined) {
    regosClientId = normalizeOptionalId(input.regos_client_id);
  }
  const categoryId = normalizeCategoryId(db, input.category_id);
  const locationRequired = requireLocation && (input.location_id !== undefined || !current?.location_id);
  const locationId = normalizeLocationId(db, input.location_id, {
    required: locationRequired,
    viewer,
  });
  const managerUserId = normalizeEmployeeId(db, input.manager_user_id, 'INVALID_TASK_MANAGER');
  const technicianUserId = action === 'sale'
    ? null
    : normalizeEmployeeId(db, input.technician_user_id, 'INVALID_TASK_TECHNICIAN');
  const currency = input.currency !== undefined
    ? normalizeDisplayCurrency(input.currency)
    : current?.currency ?? null;
  const plannedStartAt = input.planned_start_at !== undefined
    ? normalizePlannedAt(input.planned_start_at)
    : current?.planned_start_at ?? null;
  const plannedFinishAt = input.planned_finish_at !== undefined
    ? normalizePlannedAt(input.planned_finish_at)
    : current?.planned_finish_at ?? null;
  if (plannedStartAt && plannedFinishAt && new Date(plannedFinishAt) < new Date(plannedStartAt)) {
    throw new Error('INVALID_TASK_PLAN_RANGE');
  }

  const nextLocationId = locationId === undefined ? current?.location_id ?? null : locationId;
  if (requireLocation && nextLocationId == null) {
    throw new Error('INVALID_TASK_LOCATION');
  }
  if (nextLocationId != null && !canViewerAccessLocation(db, nextLocationId, viewer)) {
    throw new Error('INVALID_TASK_LOCATION');
  }

  const nextManagerUserId = managerUserId === undefined ? current?.manager_user_id ?? null : managerUserId;
  const nextTechnicianUserId = action === 'sale'
    ? null
    : (technicianUserId === undefined ? current?.technician_user_id ?? null : technicianUserId);
  assertStaffOnLocation(db, nextLocationId, nextManagerUserId, 'INVALID_TASK_MANAGER');
  assertStaffOnLocation(db, nextLocationId, nextTechnicianUserId, 'INVALID_TASK_TECHNICIAN');

  return {
    title: title || current?.title,
    status,
    action,
    notes,
    address,
    distance_km: distanceKm,
    distance_score: distanceScore,
    client_name: clientName,
    client_phone: clientPhone,
    regos_client_id: regosClientId,
    category_id: categoryId === undefined ? current?.category_id ?? null : categoryId,
    location_id: nextLocationId,
    manager_user_id: nextManagerUserId,
    technician_user_id: nextTechnicianUserId,
    currency,
    planned_start_at: plannedStartAt,
    planned_finish_at: plannedFinishAt,
  };
}

export {
  MAX_TITLE,
  MAX_NOTES,
  MAX_ADDRESS,
  MAX_CLIENT_NAME,
  MAX_CLIENT_PHONE,
  MAX_LINE_NOTES,
  MAX_LINE_QUANTITY,
  TASK_STATUSES,
  TASK_STATUS_ORDER,
  TASK_ACTIONS,
  TASK_STATUS_LABELS,
  TASK_ACTION_LABELS,
  nextTaskStatus,
  isTaskCartLocked,
  normalizeTaskInput,
  normalizeTaskDevices,
  normalizeTaskDeviceLine,
  normalizeTaskServiceLine,
  normalizeQuantity,
  applyCreateStaffAssignment,
  assertTaskCartEditable,
  assertForwardStatus,
  shouldResetTechnicianReminder,
  resolveEmployeeId,
  shouldAssignTechnicianOnStatus,
  staffAllowedOnLocation,
  sameStaffId,
  countTaskRefunds,
};
