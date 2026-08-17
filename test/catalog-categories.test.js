const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createCatalogCategory,
  deleteCatalogCategory,
  listCatalogCategories,
} = require('../src/db/catalog-categories');
const { createDevice, listDevices, updateDevice } = require('../src/db/devices');
const { createService, listServices } = require('../src/db/services');
const { openDb } = require('../src/db/partners-db');
const { setUsdUzsRate } = require('../src/db/money');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-catalog-categories-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('device and service categories', () => {
  let dbPath;
  let db;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    setUsdUzsRate(db, 12500);
  });

  after(() => {
    db.close();
    removeDbFiles(dbPath);
  });

  it('assigns, filters, and clears device categories', () => {
    const printers = createCatalogCategory(db, 'device', { name: 'Принтеры' });
    const terminals = createCatalogCategory(db, 'device', { name: 'Терминалы' });
    const printer = createDevice(db, {
      name: 'Фискальный принтер',
      category_id: printers.id,
      cost_amount: 100000,
      cost_currency: 'UZS',
      price_uzs: 150000,
    });
    createDevice(db, {
      name: 'POS-терминал',
      category_id: terminals.id,
      cost_amount: 200,
      cost_currency: 'USD',
      price_usd: 250,
    });
    createDevice(db, {
      name: 'Без категории',
      cost_amount: 1,
      cost_currency: 'UZS',
      price_uzs: 2,
    });

    assert.equal(printer.category_id, printers.id);
    assert.equal(printer.category.name, 'Принтеры');
    assert.equal(listDevices(db, { categoryId: printers.id }).total, 1);
    assert.equal(listDevices(db, { categoryId: printers.id }).devices[0].name, 'Фискальный принтер');
    assert.equal(listDevices(db, { categoryId: 'none' }).total, 1);

    deleteCatalogCategory(db, 'device', printers.id);
    const remaining = listDevices(db, { query: 'Фискальный' }).devices[0];
    assert.equal(remaining.category_id, null);
    assert.equal(listCatalogCategories(db, 'device').some((category) => category.id === printers.id), false);
  });

  it('rejects unknown device categories and keeps service categories separate', () => {
    const setup = createCatalogCategory(db, 'service', { name: 'Пуско-наладка' });
    const service = createService(db, {
      name: 'Настройка кассы',
      category_id: setup.id,
      cost_amount: 50000,
      cost_currency: 'UZS',
      price_uzs: 80000,
    });
    const device = createDevice(db, {
      name: 'Сканер',
      cost_amount: 10,
      cost_currency: 'USD',
      price_usd: 20,
    });
    assert.equal(service.category.name, 'Пуско-наладка');
    assert.equal(listServices(db, { categoryId: setup.id }).total, 1);
    assert.equal(listDevices(db, { categoryId: setup.id }).total, 0);

    assert.throws(
      () => updateDevice(db, device.id, { category_id: setup.id }),
      /INVALID_DEVICE_CATEGORY/
    );
  });
});
