import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createEmployeeUser, linkEmployeeTelegram } from '../src/db/bot-users-db';
import { openDb } from '../src/db/partners-db';
import { createTask, getTask, updateTask } from '../src/db/tasks';
import { listTasksDueForTechnicianReminder, processTaskReminders } from '../src/bot/task-reminder';
import { buildTaskReminderText } from '../src/bot/task-assignment-notify';

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-task-reminder-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
}

function removeDbFiles(dbPath?: any) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
}

function hoursFrom(now?: any, hours?: any) {
  return new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();
}

describe('task technician reminder', () => {
  let dbPath: any;
  let db: any;
  let technician: any;
  let previousBase: any;
  const now = new Date('2026-08-24T10:00:00.000Z');

  before(() => {
    previousBase = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'https://example.test';
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    technician = createEmployeeUser(db, { phone: '+998901000201', displayName: 'Техник' });
    linkEmployeeTelegram(db, technician.id, 3001);
  });

  after(() => {
    if (previousBase == null) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousBase;
    db.close();
    removeDbFiles(dbPath);
  });

  it('builds reminder text with start time and admin link', () => {
    const text = buildTaskReminderText({
      id: 7,
      title: 'Выезд',
      client_name: 'Али',
      address: 'Самарканд',
      location: { name: 'Филиал' },
      planned_start_at: '2026-08-24T11:00:00.000Z',
    });
    assert.match(text, /Через час начинается задача #7/);
    assert.match(text, /Название:<\/b> Выезд/);
    assert.match(text, /Клиент:<\/b> Али/);
    assert.match(text, /https:\/\/example\.test\/bot-admin\/tasks\/7/);
  });

  it('sends a reminder once when start is in 60 minutes', async () => {
    const task = createTask(db, {
      title: 'Через час',
      action: 'install',
      technician_user_id: technician.id,
      planned_start_at: hoursFrom(now, 1),
    });
    const sent: any[] = [];
    const first = await processTaskReminders(db, {
      now,
      sendTelegram: async (telegramId?: any, text?: any) => {
        sent.push({ telegramId, text });
        return { sent: true };
      },
    });
    assert.equal(first.filter((item?: any) => item.taskId === task!.id && item.sent).length, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].telegramId, 3001);
    assert.match(sent[0].text, /Через час/);

    const stored = getTask(db, task!.id);
    assert.ok(stored!.technician_reminder_sent_at);

    const second = await processTaskReminders(db, {
      now,
      sendTelegram: async () => {
        throw new Error('should not send again');
      },
    });
    assert.equal(second.filter((item?: any) => item.taskId === task!.id).length, 0);
  });

  it('does not treat a start in 2 hours as due', () => {
    const task = createTask(db, {
      title: 'Позже',
      action: 'repair',
      technician_user_id: technician.id,
      planned_start_at: hoursFrom(now, 2),
    });
    const due = listTasksDueForTechnicianReminder(db, now);
    assert.equal(due.some((item?: any) => item.id === task!.id), false);
  });

  it('skips done tasks and tasks without a technician', () => {
    const done = createTask(db, {
      title: 'Готово',
      action: 'install',
      status: 'done',
      technician_user_id: technician.id,
      planned_start_at: hoursFrom(now, 1),
    });
    const noTech = createTask(db, {
      title: 'Без техника',
      action: 'install',
      planned_start_at: hoursFrom(now, 1),
    });
    const dueIds = listTasksDueForTechnicianReminder(db, now).map((task?: any) => task.id);
    assert.equal(dueIds.includes(done!.id), false);
    assert.equal(dueIds.includes(noTech!.id), false);
  });

  it('clears technician_reminder_sent_at when start or technician changes', async () => {
    const task = createTask(db, {
      title: 'Сброс',
      action: 'install',
      technician_user_id: technician.id,
      planned_start_at: hoursFrom(now, 1),
    });
    await processTaskReminders(db, {
      now,
      sendTelegram: async () => ({ sent: true }),
    });
    assert.ok(getTask(db, task!.id)!.technician_reminder_sent_at);

    const rescheduled = updateTask(db, task!.id, { planned_start_at: hoursFrom(now, 3) });
    assert.equal(rescheduled!.technician_reminder_sent_at, null);

    const other = createEmployeeUser(db, { phone: '+998901000202', displayName: 'Другой' });
    linkEmployeeTelegram(db, other.id, 3002);
    await processTaskReminders(db, {
      now: new Date(now.getTime() + 2 * 60 * 60 * 1000),
      sendTelegram: async () => ({ sent: true }),
    });
    // start is now 1h from (now+2h)? hoursFrom(now,3) relative to now+2h is 1h — may send.
    const marked = getTask(db, task!.id);
    if (!marked!.technician_reminder_sent_at) {
      // not due at that frozen time; mark manually via another due window
      await processTaskReminders(db, {
        now: new Date(Date.parse(marked!.planned_start_at) - 60 * 60 * 1000),
        sendTelegram: async () => ({ sent: true }),
      });
    }
    assert.ok(getTask(db, task!.id)!.technician_reminder_sent_at);
    const reassigned = updateTask(db, task!.id, { technician_user_id: other.id });
    assert.equal(reassigned!.technician_reminder_sent_at, null);
  });
});
