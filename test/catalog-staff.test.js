const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createDevice, updateDevice } = require('../src/db/devices');
const { createService, updateService } = require('../src/db/services');
const { openDb } = require('../src/db/partners-db');
const { setUsdUzsRate } = require('../src/db/money');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-catalog-staff-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('catalog manager percent and technician score', () => {
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

  it('stores staff fields on devices and services', () => {
    const device = createDevice(db, {
      name: 'Терминал',
      cost_amount: 100,
      cost_currency: 'USD',
      price_usd: 150,
      manager_sale_percent: 12.5,
      technician_score: 8,
    });
    assert.equal(device.manager_sale_percent, 12.5);
    assert.equal(device.technician_score, 8);

    const updatedDevice = updateDevice(db, device.id, {
      manager_sale_percent: 20,
      technician_score: 10,
    });
    assert.equal(updatedDevice.manager_sale_percent, 20);
    assert.equal(updatedDevice.technician_score, 10);

    const service = createService(db, {
      name: 'Настройка',
      cost_amount: 50000,
      cost_currency: 'UZS',
      price_uzs: 80000,
    });
    assert.equal(service.manager_sale_percent, 0);
    assert.equal(service.technician_score, 0);

    const updatedService = updateService(db, service.id, {
      manager_sale_percent: 5,
      technician_score: 3,
    });
    assert.equal(updatedService.manager_sale_percent, 5);
    assert.equal(updatedService.technician_score, 3);
  });

  it('rejects invalid staff values', () => {
    assert.throws(
      () =>
        createDevice(db, {
          name: 'Bad percent',
          cost_amount: 1,
          cost_currency: 'UZS',
          price_uzs: 2,
          manager_sale_percent: 101,
        }),
      /INVALID_MANAGER_SALE_PERCENT/
    );
    assert.throws(
      () =>
        createService(db, {
          name: 'Bad score',
          cost_amount: 1,
          cost_currency: 'UZS',
          price_uzs: 2,
          technician_score: -1,
        }),
      /INVALID_TECHNICIAN_SCORE/
    );
  });
});
