const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDb } = require('../src/db/partners-db');
const { createDevice } = require('../src/db/devices');
const { createService, deleteService } = require('../src/db/services');
const { addTaskDevice, addTaskService, applyTaskDiscount, createTask, getTask, updateTask, updateTaskDevice, updateTaskService } = require('../src/db/tasks');
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
    assert.equal(task.devices[0].price_without_discount_usd, 150);
    assert.equal(task.services[0].price_uzs, 300000);
    assert.equal(task.services[0].price_without_discount_uzs, 300000);
    assert.equal(task.totals.cost_uzs, 1_500_000);
    assert.equal(task.totals.price_uzs, 2_175_000);
    assert.equal(task.totals.price_without_discount_uzs, 2_175_000);

    assert.throws(() => deleteService(db, service.id), /SERVICE_IN_USE/);
  });

  it('stores line quantity and multiplies task totals', () => {
    setUsdUzsRate(db, 12500);
    const device = createDevice(db, {
      name: 'Сканер',
      cost_amount: 50,
      cost_currency: 'USD',
      price_usd: 80,
    });
    const service = createService(db, {
      name: 'Доставка',
      cost_amount: 100000,
      cost_currency: 'UZS',
      price_uzs: 120000,
    });
    const created = createTask(db, { title: 'Количество', devices: [] });
    const withDevice = addTaskDevice(db, created.id, { device_id: device.id, action: 'install' });
    assert.equal(withDevice.devices[0].quantity, 1);

    const bumped = addTaskDevice(db, created.id, { device_id: device.id, action: 'install' });
    assert.equal(bumped.devices.length, 1);
    assert.equal(bumped.devices[0].quantity, 2);

    const qtyThree = updateTaskDevice(db, created.id, bumped.devices[0].id, { quantity: 3 });
    assert.equal(qtyThree.devices[0].quantity, 3);

    const withService = addTaskService(db, created.id, { service_id: service.id });
    const qtyTwo = updateTaskService(db, created.id, withService.services[0].id, { quantity: 2 });
    const task = getTask(db, qtyTwo.id);

    assert.equal(task.devices[0].quantity, 3);
    assert.equal(task.services[0].quantity, 2);
    assert.equal(task.totals.cost_uzs, 2_075_000);
    assert.equal(task.totals.price_uzs, 3_240_000);
    assert.equal(task.totals.price_without_discount_uzs, 3_240_000);
  });

  it('applies percent discount to one line and amount discount to all lines', () => {
    setUsdUzsRate(db, 12500);
    const device = createDevice(db, {
      name: 'Принтер',
      cost_amount: 40,
      cost_currency: 'USD',
      price_usd: 80,
    });
    const service = createService(db, {
      name: 'Установка',
      cost_amount: 100000,
      cost_currency: 'UZS',
      price_uzs: 200000,
    });
    const created = createTask(db, { title: 'Скидка', devices: [] });
    addTaskDevice(db, created.id, { device_id: device.id, action: 'install' });
    const withItems = addTaskService(db, created.id, { service_id: service.id });

    const oneLine = applyTaskDiscount(db, created.id, {
      scope: 'selected',
      lines: [{ kind: 'device', id: withItems.devices[0].id }],
      type: 'percent',
      value: 10,
    });
    assert.equal(oneLine.devices[0].discount_type, 'percent');
    assert.equal(oneLine.devices[0].price_without_discount_usd, 80);
    assert.equal(oneLine.devices[0].price_usd, 72);
    assert.equal(oneLine.services[0].price_uzs, 200000);

    const allLines = applyTaskDiscount(db, created.id, {
      scope: 'all',
      type: 'amount',
      value: 100000,
      currency: 'UZS',
    });
    assert.equal(allLines.devices[0].discount_type, 'amount');
    assert.equal(allLines.services[0].discount_type, 'amount');
    assert.equal(allLines.totals.price_without_discount_uzs, 1_200_000);
    assert.equal(allLines.totals.price_uzs, 1_100_000);
    assert.ok(allLines.devices[0].price_uzs < allLines.devices[0].price_without_discount_uzs);
    assert.ok(allLines.services[0].price_uzs < allLines.services[0].price_without_discount_uzs);
  });

  it('stores optional display currency on the task', () => {
    const both = createTask(db, { title: 'Обе валюты', devices: [] });
    assert.equal(both.currency, null);

    const uzs = createTask(db, { title: 'Сум', currency: 'uzs', devices: [] });
    assert.equal(uzs.currency, 'UZS');

    const usd = updateTask(db, uzs.id, { currency: 'USD' });
    assert.equal(usd.currency, 'USD');

    const cleared = updateTask(db, usd.id, { currency: '' });
    assert.equal(cleared.currency, null);

    assert.throws(() => createTask(db, { title: 'Bad', currency: 'EUR' }), /INVALID_TASK_CURRENCY/);
  });

  it('does not snapshot device prices on repair tasks and totals services only', () => {
    setUsdUzsRate(db, 12500);
    const device = createDevice(db, {
      name: 'Весы',
      cost_amount: 80,
      cost_currency: 'USD',
      price_usd: 120,
    });
    const service = createService(db, {
      name: 'Ремонт платы',
      cost_amount: 50000,
      cost_currency: 'UZS',
      price_uzs: 150000,
    });
    const created = createTask(db, { title: 'Ремонт весов', action: 'repair', devices: [] });
    const withDevice = addTaskDevice(db, created.id, { device_id: device.id });
    assert.equal(withDevice.devices[0].price_uzs, 0);
    assert.equal(withDevice.devices[0].price_usd, 0);
    assert.equal(withDevice.devices[0].cost_amount, 0);
    assert.equal(withDevice.totals.price_uzs, 0);

    const withService = addTaskService(db, created.id, { service_id: service.id });
    const task = getTask(db, withService.id);
    assert.equal(task.devices[0].price_uzs, 0);
    assert.equal(task.services[0].price_uzs, 150000);
    assert.equal(task.totals.price_uzs, 150000);
    assert.equal(task.totals.cost_uzs, 50000);
  });
});
