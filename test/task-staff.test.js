const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createEmployeeUser } = require('../src/db/bot-users-db');
const { openDb } = require('../src/db/partners-db');
const { advanceTaskStatus, createTask, updateTask } = require('../src/db/tasks');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-task-staff-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('task staff assignment', () => {
  let dbPath;
  let db;
  let creator;
  let other;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    creator = createEmployeeUser(db, { phone: '+998901000021', displayName: 'Создатель' });
    other = createEmployeeUser(db, { phone: '+998901000022', displayName: 'Другой' });
  });

  after(() => {
    db.close();
    removeDbFiles(dbPath);
  });

  it('assigns the creator as manager for install, repair, and sale tasks', () => {
    for (const action of ['install', 'repair', 'sale']) {
      const task = createTask(
        db,
        { title: `Задача ${action}`, action },
        { actorUserId: creator.id }
      );
      assert.equal(task.action, action);
      assert.equal(task.manager_user_id, creator.id);
      assert.equal(task.manager?.name, 'Создатель');
    }
  });

  it('keeps an explicitly chosen manager on create', () => {
    const task = createTask(
      db,
      { title: 'Менеджер выбран', action: 'install', manager_user_id: other.id },
      { actorUserId: creator.id }
    );
    assert.equal(task.manager_user_id, other.id);
  });

  it('does not assign a manager without an actor', () => {
    const task = createTask(db, { title: 'Без автора', action: 'install' });
    assert.equal(task.manager_user_id, null);
  });

  it('assigns the actor as technician when advancing install or repair to in_progress and done', () => {
    const install = createTask(db, { title: 'Установка статус', action: 'install' });
    const inProgress = advanceTaskStatus(db, install.id, undefined, { actorUserId: creator.id });
    assert.equal(inProgress.status, 'in_progress');
    assert.equal(inProgress.technician_user_id, creator.id);

    const done = advanceTaskStatus(db, install.id, undefined, { actorUserId: other.id });
    assert.equal(done.status, 'done');
    assert.equal(done.technician_user_id, other.id);

    const repair = createTask(db, { title: 'Ремонт статус', action: 'repair' });
    const repairInProgress = advanceTaskStatus(db, repair.id, undefined, { actorUserId: creator.id });
    assert.equal(repairInProgress.status, 'in_progress');
    assert.equal(repairInProgress.technician_user_id, creator.id);
  });

  it('does not assign a technician when advancing a sale task', () => {
    const sale = createTask(db, {
      title: 'Продажа статус',
      action: 'sale',
      technician_user_id: creator.id,
    });
    assert.equal(sale.technician_user_id, null);
    const inProgress = advanceTaskStatus(db, sale.id, undefined, { actorUserId: creator.id });
    assert.equal(inProgress.status, 'in_progress');
    assert.equal(inProgress.technician_user_id, null);
    const done = advanceTaskStatus(db, sale.id, undefined, { actorUserId: creator.id });
    assert.equal(done.status, 'done');
    assert.equal(done.technician_user_id, null);
  });

  it('does not assign a technician without an actor', () => {
    const task = createTask(db, { title: 'Статус без автора', action: 'install' });
    const inProgress = advanceTaskStatus(db, task.id);
    assert.equal(inProgress.status, 'in_progress');
    assert.equal(inProgress.technician_user_id, null);
  });

  it('does not assign a technician when status is changed outside the dedicated advance button', () => {
    const task = createTask(db, { title: 'Редактор статуса', action: 'install' });
    const updated = updateTask(db, task.id, { status: 'in_progress' });
    assert.equal(updated.status, 'in_progress');
    assert.equal(updated.technician_user_id, null);
  });
});
