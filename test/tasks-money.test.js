const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDb } = require('../src/db/partners-db');
const { createDevice } = require('../src/db/devices');
const { createService, deleteService } = require('../src/db/services');
const { addTaskDevice, addTaskService, createTask, getTask } = require('../src/db/tasks');
const { setUsdUzsRate } = require('../src/db/money');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-tasks-money-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('task details money snapshots', () => {
  let dbPath;
  let db;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
  });

  after(() => {
    db.close();
    removeDbFiles(dbPath);
  });

  it('creates an empty task and snapshots catalog money onto added lines', () => {
    setUsdUzsRate(db, 12500);
    const device = createDevice(db, {
      name: 'POS-терминал',
      cost_amount: 100,
      cost_currency: 'USD',
      price_usd: 150,
    });
    const service = createService(db, {
      name: 'Настройка',
      cost_amount: 250000,
      cost_currency: 'UZS',
      price_uzs: 300000,
    });

    const created = createTask(db, { title: 'Выезд', devices: [] });
    assert.equal(created.devices.length, 0);
    assert.equal(created.services.length, 0);

    const withDevice = addTaskDevice(db, created.id, { device_id: device.id, action: 'install' });
    const withService = addTaskService(db, created.id, { service_id: service.id });
    const task = getTask(db, withService.id);

    assert.equal(withDevice.devices.length, 1);
    assert.equal(task.services.length, 1);
    assert.equal(task.devices[0].cost_amount, 100);
    assert.equal(task.devices[0].cost_currency, 'USD');
    assert.equal(task.devices[0].price_usd, 150);
    assert.equal(task.services[0].price_uzs, 300000);
    assert.equal(task.totals.cost_uzs, 1_500_000);
    assert.equal(task.totals.price_uzs, 2_175_000);

    assert.throws(() => deleteService(db, service.id), /SERVICE_IN_USE/);
  });
});
