const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createEmployeeUser, linkEmployeeTelegram } = require('../src/db/bot-users-db');
const { openDb } = require('../src/db/partners-db');
const { advanceTaskStatus, createTask, getTask, updateTask } = require('../src/db/tasks');
const {
  buildTaskAssignmentText,
  buildTaskStatusChangeText,
  notifyTaskStaffAssignments,
  staffAssignmentChanges,
  staffRecipients,
} = require('../src/bot/task-assignment-notify');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-task-assignment-notify-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
}

function removeDbFiles(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
}

describe('task assignment notify', () => {
  let dbPath;
  let db;
  let actor;
  let manager;
  let technician;
  let previousBase;

  before(() => {
    previousBase = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'https://example.test';
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    actor = createEmployeeUser(db, { phone: '+998901000101', displayName: 'Автор' });
    manager = createEmployeeUser(db, { phone: '+998901000102', displayName: 'Менеджер' });
    technician = createEmployeeUser(db, { phone: '+998901000103', displayName: 'Техник' });
    linkEmployeeTelegram(db, actor.id, 2001);
    linkEmployeeTelegram(db, manager.id, 2002);
    linkEmployeeTelegram(db, technician.id, 2003);
  });

  after(() => {
    if (previousBase == null) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousBase;
    db.close();
    removeDbFiles(dbPath);
  });

  it('builds assignment text with title, role, client, and admin link', () => {
    const text = buildTaskAssignmentText(
      {
        id: 42,
        title: 'Установка кассы',
        action_label: 'Установка',
        status_label: 'Новая',
        client_name: 'Иван',
        client_phone: '+998901112233',
        address: 'Ташкент',
        location: { name: 'Офис' },
      },
      ['manager']
    );
    assert.match(text, /Вам назначена задача #42/);
    assert.match(text, /Роль:<\/b> менеджер/);
    assert.match(text, /Название:<\/b> Установка кассы/);
    assert.match(text, /Клиент:<\/b> Иван/);
    assert.match(text, /https:\/\/example\.test\/bot-admin\/tasks\/42/);
  });

  it('detects new manager and technician assignments', () => {
    assert.deepEqual(
      staffAssignmentChanges(
        { manager_user_id: 1, technician_user_id: null },
        { manager_user_id: 2, technician_user_id: 3 }
      ),
      [
        { role: 'manager', userId: 2 },
        { role: 'technician', userId: 3 },
      ]
    );
    assert.deepEqual(
      staffAssignmentChanges(
        { manager_user_id: 2, technician_user_id: 3 },
        { manager_user_id: 2, technician_user_id: 3 }
      ),
      []
    );
  });

  it('notifies an explicitly chosen manager on create', async () => {
    const sent = [];
    const task = createTask(
      db,
      {
        title: 'Чужой менеджер',
        action: 'install',
        manager_user_id: manager.id,
        client_name: 'Клиент',
      },
      { actorUserId: actor.id }
    );
    const result = await notifyTaskStaffAssignments(db, {
      before: null,
      after: task,
      actorUserId: actor.id,
      sendTelegram: async (telegramId, text) => {
        sent.push({ telegramId, text });
        return { sent: true };
      },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].telegramId, 2002);
    assert.match(sent[0].text, /Чужой менеджер/);
    assert.equal(result.sent.filter((item) => item.sent).length, 1);
  });

  it('notifies only the new technician on update', async () => {
    const task = createTask(db, {
      title: 'Смена техника',
      action: 'repair',
      technician_user_id: technician.id,
    });
    const other = createEmployeeUser(db, { phone: '+998901000104', displayName: 'Другой техник' });
    linkEmployeeTelegram(db, other.id, 2004);
    const updated = updateTask(db, task.id, { technician_user_id: other.id });
    const sent = [];
    await notifyTaskStaffAssignments(db, {
      before: task,
      after: updated,
      actorUserId: actor.id,
      sendTelegram: async (telegramId, text) => {
        sent.push({ telegramId, text });
        return { sent: true };
      },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].telegramId, 2004);
    assert.match(sent[0].text, /техник/);
  });

  it('does not send when staff is unchanged', async () => {
    const task = createTask(db, {
      title: 'Без смены',
      action: 'install',
      manager_user_id: manager.id,
    });
    const sent = [];
    await notifyTaskStaffAssignments(db, {
      before: task,
      after: getTask(db, task.id),
      actorUserId: actor.id,
      sendTelegram: async (telegramId, text) => {
        sent.push({ telegramId, text });
        return { sent: true };
      },
    });
    assert.equal(sent.length, 0);
  });

  it('notifies the auto-assigned manager when a task is created', async () => {
    const sent = [];
    const task = createTask(
      db,
      { title: 'Создана задача', action: 'install' },
      { actorUserId: actor.id }
    );
    await notifyTaskStaffAssignments(db, {
      before: null,
      after: task,
      actorUserId: actor.id,
      sendTelegram: async (telegramId, text) => {
        sent.push({ telegramId, text });
        return { sent: true };
      },
    });
    assert.equal(task.manager_user_id, actor.id);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].telegramId, 2001);
    assert.match(sent[0].text, /Вам назначена задача/);
    assert.match(sent[0].text, /Создана задача/);
  });

  it('notifies the actor when they become the technician on advance', async () => {
    const task = createTask(db, { title: 'Самоназначение', action: 'install' });
    const advanced = advanceTaskStatus(db, task.id, undefined, { actorUserId: actor.id });
    const sent = [];
    await notifyTaskStaffAssignments(db, {
      before: task,
      after: advanced,
      actorUserId: actor.id,
      sendTelegram: async (telegramId, text) => {
        sent.push({ telegramId, text });
        return { sent: true };
      },
    });
    assert.equal(advanced.technician_user_id, actor.id);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].telegramId, 2001);
    assert.match(sent[0].text, /Вам назначена задача/);
    assert.match(sent[0].text, /техник/);
  });

  it('skips employees without telegram', async () => {
    const unlinked = createEmployeeUser(db, { phone: '+998901000105', displayName: 'Без Telegram' });
    const task = createTask(db, {
      title: 'Нет телеграма',
      action: 'install',
      manager_user_id: unlinked.id,
    });
    const sent = [];
    const result = await notifyTaskStaffAssignments(db, {
      before: null,
      after: task,
      actorUserId: actor.id,
      sendTelegram: async (telegramId, text) => {
        sent.push({ telegramId, text });
        return { sent: true };
      },
    });
    assert.equal(sent.length, 0);
    assert.equal(result.sent[0]?.reason, 'no_telegram');
  });

  it('builds status-change text with old and new labels and admin link', () => {
    const text = buildTaskStatusChangeText(
      { id: 42, status: 'new', status_label: 'Новая' },
      {
        id: 42,
        title: 'Установка кассы',
        action_label: 'Установка',
        status: 'in_progress',
        status_label: 'В работе',
        client_name: 'Иван',
        location: { name: 'Офис' },
      }
    );
    assert.match(text, /Статус задачи #42 изменён/);
    assert.match(text, /Статус:<\/b> Новая → В работе/);
    assert.match(text, /Название:<\/b> Установка кассы/);
    assert.match(text, /Клиент:<\/b> Иван/);
    assert.doesNotMatch(text, /Статус:<\/b> В работе$/m);
    assert.match(text, /https:\/\/example\.test\/bot-admin\/tasks\/42/);
  });

  it('lists unique assigned manager and technician as status recipients', () => {
    assert.deepEqual(
      staffRecipients({ manager_user_id: 2, technician_user_id: 3 }),
      [2, 3]
    );
    assert.deepEqual(
      staffRecipients({ manager_user_id: 2, technician_user_id: 2 }),
      [2]
    );
    assert.deepEqual(staffRecipients({ manager_user_id: null, technician_user_id: null }), []);
  });

  it('notifies assigned staff when status changes without staff change', async () => {
    const task = createTask(db, {
      title: 'Смена статуса',
      action: 'install',
      manager_user_id: manager.id,
      technician_user_id: technician.id,
    });
    const updated = updateTask(db, task.id, { status: 'in_progress' });
    const sent = [];
    const result = await notifyTaskStaffAssignments(db, {
      before: task,
      after: updated,
      actorUserId: actor.id,
      sendTelegram: async (telegramId, text) => {
        sent.push({ telegramId, text });
        return { sent: true };
      },
    });
    assert.equal(sent.length, 2);
    assert.deepEqual(
      sent.map((item) => item.telegramId).sort(),
      [2002, 2003]
    );
    for (const item of sent) {
      assert.match(item.text, /Статус задачи #\d+ изменён/);
      assert.match(item.text, /Новая → В работе/);
    }
    assert.equal(result.sent.filter((item) => item.kind === 'status' && item.sent).length, 2);
  });

  it('notifies assigned staff including the actor on status change', async () => {
    const task = createTask(db, {
      title: 'Автор меняет статус',
      action: 'install',
      manager_user_id: manager.id,
      technician_user_id: technician.id,
    });
    const updated = updateTask(db, task.id, { status: 'in_progress' });
    const sent = [];
    await notifyTaskStaffAssignments(db, {
      before: task,
      after: updated,
      actorUserId: manager.id,
      sendTelegram: async (telegramId, text) => {
        sent.push({ telegramId, text });
        return { sent: true };
      },
    });
    assert.equal(sent.length, 2);
    assert.deepEqual(
      sent.map((item) => item.telegramId).sort(),
      [2002, 2003]
    );
    for (const item of sent) {
      assert.match(item.text, /изменён/);
    }
  });

  it('does not send a second status message to a newly assigned employee', async () => {
    const task = createTask(db, {
      title: 'Назначение и статус',
      action: 'repair',
      manager_user_id: manager.id,
    });
    const updated = updateTask(db, task.id, {
      technician_user_id: technician.id,
      status: 'in_progress',
    });
    const sent = [];
    await notifyTaskStaffAssignments(db, {
      before: task,
      after: updated,
      actorUserId: actor.id,
      sendTelegram: async (telegramId, text) => {
        sent.push({ telegramId, text });
        return { sent: true };
      },
    });
    assert.equal(sent.length, 2);
    const technicianMsg = sent.find((item) => item.telegramId === 2003);
    const managerMsg = sent.find((item) => item.telegramId === 2002);
    assert.match(technicianMsg.text, /Вам назначена задача/);
    assert.doesNotMatch(technicianMsg.text, /изменён/);
    assert.match(managerMsg.text, /Статус задачи #\d+ изменён/);
    assert.doesNotMatch(managerMsg.text, /Вам назначена задача/);
  });

  it('does not send a status message when status is unchanged', async () => {
    const task = createTask(db, {
      title: 'Тот же статус',
      action: 'install',
      manager_user_id: manager.id,
      technician_user_id: technician.id,
    });
    const sent = [];
    await notifyTaskStaffAssignments(db, {
      before: task,
      after: getTask(db, task.id),
      actorUserId: actor.id,
      sendTelegram: async (telegramId, text) => {
        sent.push({ telegramId, text });
        return { sent: true };
      },
    });
    assert.equal(sent.length, 0);
  });
});
