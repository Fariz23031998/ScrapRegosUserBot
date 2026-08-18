const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createEmployeeUser } = require('../src/db/bot-users-db');
const { createDevice } = require('../src/db/devices');
const { openDb } = require('../src/db/partners-db');
const { addTaskDevice, createTask, updateTask } = require('../src/db/tasks');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-task-actions-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('task sale action', () => {
  let dbPath;
  let db;
  let technician;
  let device;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    technician = createEmployeeUser(db, { phone: '+998901000011', displayName: 'Техник' });
    device = createDevice(db, { name: 'Касса', price_uzs: 1000000 });
  });

  after(() => {
    db.close();
    removeDbFiles(dbPath);
  });

  it('creates a sale task with the sale label', () => {
    const task = createTask(db, { title: 'Продажа кассы', action: 'sale' });
    assert.equal(task.action, 'sale');
    assert.equal(task.action_label, 'Продажа');
    assert.equal(task.technician_user_id, null);
  });

  it('ignores a technician on sale create', () => {
    const task = createTask(db, {
      title: 'Продажа без техника',
      action: 'sale',
      technician_user_id: technician.id,
    });
    assert.equal(task.action, 'sale');
    assert.equal(task.technician_user_id, null);
    assert.equal(task.technician, null);
  });

  it('inherits sale onto a device line when action is omitted', () => {
    const created = createTask(db, { title: 'Продажа устройства', action: 'sale' });
    const task = addTaskDevice(db, created.id, { device_id: device.id });
    assert.equal(task.devices.length, 1);
    assert.equal(task.devices[0].action, 'sale');
    assert.equal(task.devices[0].action_label, 'Продажа');
  });

  it('rewrites device action and clears technician when type changes to sale', () => {
    const created = createTask(db, {
      title: 'Установка потом продажа',
      action: 'install',
      technician_user_id: technician.id,
    });
    const withDevice = addTaskDevice(db, created.id, { device_id: device.id });
    assert.equal(withDevice.technician_user_id, technician.id);
    assert.equal(withDevice.devices[0].action, 'install');

    const updated = updateTask(db, withDevice.id, { action: 'sale' });
    assert.equal(updated.action, 'sale');
    assert.equal(updated.action_label, 'Продажа');
    assert.equal(updated.technician_user_id, null);
    assert.equal(updated.devices[0].action, 'sale');
  });

  it('rejects an unknown task action', () => {
    assert.throws(
      () => createTask(db, { title: 'Неизвестный тип', action: 'purchase' }),
      { message: 'INVALID_TASK_ACTION' }
    );
  });
});
