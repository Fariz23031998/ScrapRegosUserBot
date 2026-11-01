import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { getBotUserById } from '../db/bot-users-db';
import { formatOrderDateTimeValue } from './order-datetime';
import { bold, field, link, withHtml } from './telegram-html';

const ROLE_LABELS: Record<string, string> = {
  manager: 'менеджер',
  technician: 'техник',
};

function formatTelegramChatId(telegramId?: any) {
  if (typeof telegramId === 'bigint') return telegramId.toString();
  return telegramId;
}

function sameUserId(left?: any, right?: any) {
  if (left == null || left === '' || right == null || right === '') return false;
  return Number(left) === Number(right);
}

function staffAssignmentChanges(before?: any, after?: any) {
  const changes: any[] = [];
  const afterManager = after?.manager_user_id ?? null;
  const afterTechnician = after?.technician_user_id ?? null;
  if (afterManager != null && !sameUserId(afterManager, before?.manager_user_id)) {
    changes.push({ role: 'manager', userId: Number(afterManager) });
  }
  if (afterTechnician != null && !sameUserId(afterTechnician, before?.technician_user_id)) {
    changes.push({ role: 'technician', userId: Number(afterTechnician) });
  }
  return changes;
}

function groupAssignmentsByUser(changes?: any) {
  const byUser: Map<any, any> = new Map();
  for (const change of changes) {
    const current = byUser.get(change.userId) || { userId: change.userId, roles: [] };
    if (!current.roles.includes(change.role)) current.roles.push(change.role);
    byUser.set(change.userId, current);
  }
  return [...byUser.values()];
}

function staffRecipients(task?: any) {
  const ids: any[] = [];
  const seen: Set<any> = new Set();
  for (const value of [task?.manager_user_id, task?.technician_user_id]) {
    if (value == null || value === '') continue;
    const userId = Number(value);
    if (!Number.isFinite(userId) || seen.has(userId)) continue;
    seen.add(userId);
    ids.push(userId);
  }
  return ids;
}

function taskStatusChanged(before?: any, after?: any) {
  if (!before || !after) return false;
  return String(before.status ?? '') !== String(after.status ?? '');
}

function statusLabel(task?: any) {
  const label = task?.status_label != null ? String(task.status_label).trim() : '';
  if (label) return label;
  return task?.status != null ? String(task.status) : '';
}

function formatRoleList(roles?: any) {
  return (roles || [])
    .map((role?: any) => ROLE_LABELS[role as string] || role)
    .filter(Boolean)
    .join(', ');
}

function taskAdminUrl(taskId?: any) {
  const base = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return base ? `${base}/bot-admin/tasks/${taskId}` : null;
}

function formatPlanRange(task?: any) {
  const start = formatOrderDateTimeValue(task?.planned_start_at);
  const finish = formatOrderDateTimeValue(task?.planned_finish_at);
  if (start && finish) return `${start} — ${finish}`;
  return start || finish || '';
}

function pushField(lines?: any, label?: any, value?: any) {
  const text = value == null ? '' : String(value).trim();
  if (!text) return;
  lines.push(field('', label, text));
}

function buildTaskDetailLines(task: any, { omitStatus = false }: Unchecked = {}) {
  const lines: any[] = [];
  pushField(lines, 'Название', task?.title);
  pushField(lines, 'Тип', task?.action_label);
  if (!omitStatus) pushField(lines, 'Статус', task?.status_label);
  pushField(lines, 'Клиент', task?.client_name);
  pushField(lines, 'Телефон', task?.client_phone);
  pushField(lines, 'Адрес', task?.address);
  pushField(lines, 'Филиал', task?.location?.name);
  pushField(lines, 'План', formatPlanRange(task));
  return lines;
}

function buildTaskLinkLine(taskId?: any) {
  const url = taskAdminUrl(taskId);
  return url ? link(url, 'Открыть в админке') : `задача #${taskId}`;
}

function compactText(lines?: any) {
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildTaskAssignmentText(task?: any, roles?: any) {
  return compactText([
    bold(`Вам назначена задача #${task.id}`),
    field('', 'Роль', formatRoleList(roles) || 'сотрудник'),
    '',
    ...buildTaskDetailLines(task),
    '',
    buildTaskLinkLine(task.id),
  ]);
}

function buildTaskReminderText(task?: any) {
  const start = formatOrderDateTimeValue(task?.planned_start_at);
  return compactText([
    bold(`Через час начинается задача #${task.id}`),
    '',
    ...buildTaskDetailLines(task),
    start ? field('', 'Начало', start) : '',
    '',
    buildTaskLinkLine(task.id),
  ]);
}

function buildTaskStatusChangeText(before?: any, after?: any) {
  const from = statusLabel(before);
  const to = statusLabel(after);
  const statusValue = from && to ? `${from} → ${to}` : to || from;
  return compactText([
    bold(`Статус задачи #${after.id} изменён`),
    statusValue ? field('', 'Статус', statusValue) : '',
    '',
    ...buildTaskDetailLines(after, { omitStatus: true }),
    '',
    buildTaskLinkLine(after.id),
  ]);
}

function telegramErrorMessage(error: Error & { response?: { body?: { description?: string } } }) {
  return error?.response?.body?.description || error?.message || String(error);
}

function stripHtml(text?: any) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

async function defaultSendTelegram(telegramId?: any, text?: any) {
  if (telegramId == null) return { sent: false, reason: 'no_telegram_id' };
  const { getOutboundBot } = (require('./payment-notification') as typeof import('./payment-notification'));
  const bot = getOutboundBot();
  if (!bot) {
    console.warn('[task-notify] TELEGRAM_BOT_TOKEN not set — skipping notification.');
    return { sent: false, reason: 'no_bot' };
  }
  const chatId = String(formatTelegramChatId(telegramId));
  try {
    await bot.sendMessage(chatId, text, withHtml());
    return { sent: true };
  } catch (error: any) {
    console.warn('[task-notify] HTML send failed, retrying plain text:', telegramErrorMessage(error));
    await bot.sendMessage(chatId, stripHtml(text));
    return { sent: true };
  }
}

async function notifyEmployee(db: Db, send: any, sent: any, { userId, roles, kind, text }: Unchecked) {
  const user = getBotUserById(db, userId);
  if (!user || user.role !== 'employee') {
    sent.push({ userId, roles, kind, sent: false, reason: 'employee_not_found' });
    return;
  }
  if (user.telegram_id == null) {
    sent.push({ userId, roles, kind, sent: false, reason: 'no_telegram' });
    return;
  }
  try {
    const result = await send(user.telegram_id, text);
    const ok = result?.sent !== false;
    sent.push({
      userId,
      roles,
      kind,
      sent: ok,
      reason: ok ? undefined : result?.reason || 'send_failed',
    });
  } catch (error: any) {
    console.warn(`[task-notify] Failed to notify ${userId}:`, error.message);
    sent.push({ userId, roles, kind, sent: false, reason: error.message });
  }
}

async function notifyTaskStaffAssignments(
  db: Db,
  { before = null, after, actorUserId = null, sendTelegram }: Unchecked = {}
) {
  if (!after) return { sent: [] };
  const grouped = groupAssignmentsByUser(staffAssignmentChanges(before, after));
  const send = sendTelegram || defaultSendTelegram;
  const sent: any[] = [];

  for (const item of grouped) {
    await notifyEmployee(db, send, sent, {
      userId: item.userId,
      roles: item.roles,
      kind: 'assignment',
      text: buildTaskAssignmentText(after, item.roles),
    });
  }

  if (taskStatusChanged(before, after)) {
    const assignmentUserIds: Set<any> = new Set(grouped.map((item?: any) => Number(item.userId)));
    const text = buildTaskStatusChangeText(before, after);
    for (const userId of staffRecipients(after)) {
      if (assignmentUserIds.has(Number(userId))) continue;
      await notifyEmployee(db, send, sent, {
        userId,
        roles: [],
        kind: 'status',
        text,
      });
    }
  }

  return { sent };
}

function scheduleTaskAssignmentNotify(db: Db, payload?: any) {
  void notifyTaskStaffAssignments(db, payload)
    .then((result?: any) => {
      const failed = (result?.sent || []).filter((item?: any) => !item.sent);
      if (failed.length) {
        console.warn('[task-notify] Some notifications were not sent:', failed);
      }
    })
    .catch((error: Error) => {
      console.warn('[task-notify] Failed:', error.message);
    });
}

export {
  staffAssignmentChanges,
  staffRecipients,
  taskStatusChanged,
  buildTaskAssignmentText,
  buildTaskReminderText,
  buildTaskStatusChangeText,
  notifyTaskStaffAssignments,
  scheduleTaskAssignmentNotify,
  formatTelegramChatId,
  defaultSendTelegram,
};
