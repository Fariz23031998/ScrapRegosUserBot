const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDb } = require('../src/db/partners-db');
const { createDevice } = require('../src/db/devices');
const { createService } = require('../src/db/services');
const { addTaskDevice, addTaskService, createTask, getTask, postTask, unpostTask, advanceTaskStatus } = require('../src/db/tasks');
const { setUsdUzsRate } = require('../src/db/money');
const {
  createTaskDeviceReturn,
  deleteTaskDeviceReturn,
  listRepairDeviceReturns,
} = require('../src/db/task-device-returns');
const {
  getRepairReturnSettingsPublic,
  isRepairReturnRequireSerials,
  saveRepairReturnSettings,
} = require('../src/db/repair-return-settings');
const { listSerialsForLine } = require('../src/db/task-device-serials');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-task-device-returns-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

function finalizeTask(db, taskId) {
  advanceTaskStatus(db, taskId);
  advanceTaskStatus(db, taskId);
  return postTask(db, taskId);
}

describe('task device returns', () => {
  let dbPath;
  let db;
  let device;
  let service;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    setUsdUzsRate(db, 12500);
    device = createDevice(db, {
      name: 'Касса',
      cost_amount: 40000,
      cost_currency: 'UZS',
      price_uzs: 100000,
    });
    service = createService(db, {
      name: 'Ремонт',
      cost_amount: 10000,
      cost_currency: 'UZS',
      price_uzs: 25000,
    });
  });

  after(() => {
    db.close();
    removeDbFiles(dbPath);
  });

  beforeEach(() => {
    saveRepairReturnSettings(db, { require_serials: false });
  });

  it('rejects return unless the task is repair, done and posted', () => {
    const sale = createTask(db, { title: 'Продажа кассы', action: 'sale', devices: [] });
    addTaskDevice(db, sale.id, { device_id: device.id, quantity: 1 });
    assert.throws(
      () => createTaskDeviceReturn(db, { device_line_id: getTask(db, sale.id).devices[0].id }),
      /TASK_NOT_REPAIR/
    );

    const repair = createTask(db, { title: 'Ремонт черновик', action: 'repair', devices: [] });
    addTaskDevice(db, repair.id, { device_id: device.id, quantity: 1 });
    const lineId = getTask(db, repair.id).devices[0].id;
    assert.throws(() => createTaskDeviceReturn(db, { device_line_id: lineId }), /TASK_NOT_DONE/);

    advanceTaskStatus(db, repair.id);
    advanceTaskStatus(db, repair.id);
    assert.throws(() => createTaskDeviceReturn(db, { device_line_id: lineId }), /TASK_NOT_POSTED/);
  });

  it('returns remaining qty, lists pending vs returned, and exposes returned_quantity on getTask', () => {
    const created = createTask(db, { title: 'Ремонт кассы возврат', action: 'repair', devices: [] });
    addTaskDevice(db, created.id, { device_id: device.id, quantity: 2 });
    addTaskService(db, created.id, { service_id: service.id });
    finalizeTask(db, created.id);
    const lineId = getTask(db, created.id).devices[0].id;

    const pendingBefore = listRepairDeviceReturns(db, { status: 'pending' });
    assert.equal(
      pendingBefore.items.some((item) => item.device_line_id === lineId && item.remaining_quantity === 2),
      true
    );

    const first = createTaskDeviceReturn(db, { device_line_id: lineId, quantity: 1 });
    assert.equal(first.item.return_quantity, 1);
    assert.equal(first.task.devices[0].returned_quantity, 1);
    assert.equal(first.task.devices[0].remaining_return_quantity, 1);

    assert.throws(
      () => createTaskDeviceReturn(db, { device_line_id: lineId, quantity: 2 }),
      /INVALID_TASK_RETURN_QUANTITY/
    );

    const second = createTaskDeviceReturn(db, { device_line_id: lineId });
    assert.equal(second.item.return_quantity, 1);
    const task = getTask(db, created.id);
    assert.equal(task.devices[0].returned_quantity, 2);
    assert.equal(task.devices[0].remaining_return_quantity, 0);

    const pendingAfter = listRepairDeviceReturns(db, { status: 'pending' });
    assert.equal(pendingAfter.items.some((item) => item.device_line_id === lineId), false);

    const returned = listRepairDeviceReturns(db, { status: 'returned' });
    const forTask = returned.items.filter((item) => item.device_line_id === lineId);
    assert.equal(forTask.length, 2);

    deleteTaskDeviceReturn(db, second.item.id);
    const afterUndo = getTask(db, created.id);
    assert.equal(afterUndo.devices[0].returned_quantity, 1);
  });

  it('blocks unpost while device returns exist unless deleteReturns is set', () => {
    const created = createTask(db, { title: 'Ремонт отмена проведения', action: 'repair', devices: [] });
    addTaskDevice(db, created.id, { device_id: device.id, quantity: 1 });
    finalizeTask(db, created.id);
    const lineId = getTask(db, created.id).devices[0].id;
    createTaskDeviceReturn(db, { device_line_id: lineId, quantity: 1 });

    assert.throws(() => unpostTask(db, created.id), /TASK_HAS_DEVICE_RETURNS/);
    assert.equal(getTask(db, created.id).posted, true);
    assert.equal(getTask(db, created.id).devices[0].returned_quantity, 1);

    const unposted = unpostTask(db, created.id, null, { deleteReturns: true });
    assert.equal(unposted.posted, false);
    assert.equal(unposted.devices[0].returned_quantity, 0);
    assert.equal(listRepairDeviceReturns(db, { status: 'returned' }).items.some((item) => item.device_line_id === lineId), false);
  });

  it('persists the require-serials setting off by default', () => {
    assert.equal(getRepairReturnSettingsPublic(db).require_serials, false);
    saveRepairReturnSettings(db, { require_serials: true });
    assert.equal(isRepairReturnRequireSerials(db), true);
    assert.equal(getRepairReturnSettingsPublic(db).require_serials, true);
    saveRepairReturnSettings(db, { require_serials: false });
    assert.equal(isRepairReturnRequireSerials(db), false);
  });

  it('requires serials when the setting is on and consumes the requested codes', () => {
    saveRepairReturnSettings(db, { require_serials: true });
    const created = createTask(db, { title: 'Ремонт серийники', action: 'repair', devices: [] });
    addTaskDevice(db, created.id, { device_id: device.id, quantity: 2 });
    finalizeTask(db, created.id);
    const lineId = getTask(db, created.id).devices[0].id;
    const serials = listSerialsForLine(db, lineId);
    assert.equal(serials.length, 2);

    assert.throws(
      () => createTaskDeviceReturn(db, { device_line_id: lineId, quantity: 1 }),
      /TASK_RETURN_SERIALS_REQUIRED/
    );

    const second = serials[1];
    const firstReturn = createTaskDeviceReturn(db, {
      device_line_id: lineId,
      serial_codes: [second.code.toLowerCase()],
    });
    assert.equal(firstReturn.serials.length, 1);
    assert.equal(firstReturn.serials[0].id, second.id);
    assert.equal(firstReturn.item.return_quantity, 1);

    assert.throws(
      () => createTaskDeviceReturn(db, { device_line_id: lineId, serial_ids: [second.id] }),
      /INVALID_TASK_RETURN_SERIAL/
    );
    assert.throws(
      () => createTaskDeviceReturn(db, { device_line_id: lineId, serial_codes: ['SR99999999'] }),
      /INVALID_TASK_RETURN_SERIAL/
    );

    const first = serials[0];
    const secondReturn = createTaskDeviceReturn(db, {
      device_line_id: lineId,
      serial_ids: [first.id],
    });
    assert.equal(secondReturn.serials[0].id, first.id);
    assert.equal(getTask(db, created.id).devices[0].remaining_return_quantity, 0);
  });

  it('consumes specific serials even when the setting is off', () => {
    const other = createTask(db, { title: 'Ремонт чужой серийник', action: 'repair', devices: [] });
    addTaskDevice(db, other.id, { device_id: device.id, quantity: 1 });
    finalizeTask(db, other.id);
    const otherSerial = listSerialsForLine(db, getTask(db, other.id).devices[0].id)[0];

    const created = createTask(db, { title: 'Ремонт FIFO и выбор', action: 'repair', devices: [] });
    addTaskDevice(db, created.id, { device_id: device.id, quantity: 2 });
    finalizeTask(db, created.id);
    const lineId = getTask(db, created.id).devices[0].id;
    const serials = listSerialsForLine(db, lineId);

    assert.throws(
      () => createTaskDeviceReturn(db, { device_line_id: lineId, serial_ids: [otherSerial.id] }),
      /INVALID_TASK_RETURN_SERIAL/
    );

    const fifo = createTaskDeviceReturn(db, { device_line_id: lineId, quantity: 1 });
    assert.equal(fifo.serials[0].id, serials[0].id);

    const specific = createTaskDeviceReturn(db, {
      device_line_id: lineId,
      serial_ids: [serials[1].id],
    });
    assert.equal(specific.serials[0].id, serials[1].id);
  });
});
