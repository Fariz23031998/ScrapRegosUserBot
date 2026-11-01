import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { getBotUserById } from '../db/bot-users-db';
import { ensureTaskTables, getTask } from '../db/tasks';
import { buildTaskReminderText, defaultSendTelegram } from './task-assignment-notify';

const REMINDER_LEAD_MS = 60 * 60 * 1000;
const REMINDER_GRACE_MS = 2 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60_000;

function toIso(value?: any) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function listTasksDueForTechnicianReminder(db: Db, now: any = new Date()) {
  ensureTaskTables(db);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const from = new Date(nowMs - REMINDER_GRACE_MS).toISOString();
  const to = new Date(nowMs + REMINDER_LEAD_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT id
       FROM tasks
       WHERE technician_user_id IS NOT NULL
         AND planned_start_at IS NOT NULL
         AND status != 'done'
         AND technician_reminder_sent_at IS NULL
         AND planned_start_at >= ?
         AND planned_start_at <= ?`
    )
    .all(from, to);
  return rows.map((row?: any) => getTask(db, row.id)).filter(Boolean);
}

function markTechnicianReminderSent(db: Db, taskId: any, at: any = new Date()) {
  db.prepare('UPDATE tasks SET technician_reminder_sent_at = ? WHERE id = ?').run(toIso(at), taskId);
}

async function processTaskReminders(db: Db, { now = new Date(), sendTelegram }: Unchecked = {}) {
  const tasks = listTasksDueForTechnicianReminder(db, now);
  const send = sendTelegram || defaultSendTelegram;
  const results: any[] = [];

  for (const task of tasks) {
    const user = getBotUserById(db, task!.technician_user_id);
    if (!user || user.telegram_id == null) {
      results.push({ taskId: task!.id, sent: false, reason: 'no_telegram' });
      continue;
    }
    try {
      const result = await send(user.telegram_id, buildTaskReminderText(task));
      const ok = result?.sent !== false;
      if (ok) markTechnicianReminderSent(db, task!.id, now);
      results.push({
        taskId: task!.id,
        sent: ok,
        reason: ok ? undefined : result?.reason || 'send_failed',
      });
    } catch (error: any) {
      console.warn(`[task-reminder] Failed for task ${task!.id}:`, error.message);
      results.push({ taskId: task!.id, sent: false, reason: error.message });
    }
  }

  return results;
}

function startTaskReminderWorker(db: Db, { intervalMs = DEFAULT_INTERVAL_MS, sendTelegram }: Unchecked = {}) {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processTaskReminders(db, { sendTelegram });
    } catch (error: any) {
      console.error('[task-reminder] tick failed:', error.message || error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  const initial = setTimeout(tick, Math.min(5_000, intervalMs));
  if (typeof initial.unref === 'function') initial.unref();

  console.log(`[task-reminder] worker started (every ${intervalMs}ms)`);
  return {
    stop() {
      clearInterval(timer);
      clearTimeout(initial);
    },
    tick,
  };
}

export {
  REMINDER_LEAD_MS,
  REMINDER_GRACE_MS,
  listTasksDueForTechnicianReminder,
  processTaskReminders,
  startTaskReminderWorker,
  markTechnicianReminderSent,
};
