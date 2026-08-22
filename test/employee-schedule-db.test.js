const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createEmployeeUser,
  updateEmployeeUser,
  convertCustomerToEmployee,
  registerCustomer,
  getEmployeeWithRights,
} = require('../src/db/bot-users-db');
const { openDb } = require('../src/db/partners-db');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-employee-schedule-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('employee schedule persistence', () => {
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

  it('stores and updates a weekly schedule', () => {
    const created = createEmployeeUser(db, {
      phone: '+998901000041',
      displayName: 'Техник',
      schedule: { mon: { start: '09:00', end: '18:00' }, fri: { start: '10:00', end: '16:00' } },
    });
    assert.equal(created.schedule.mon.start, '09:00');
    assert.equal(created.schedule.fri.end, '16:00');
    assert.equal(created.schedule.sun, null);

    const updated = updateEmployeeUser(db, created.id, {
      schedule: { tue: { start: '08:30', end: '17:00' } },
    });
    assert.equal(updated.schedule.tue.start, '08:30');
    assert.equal(updated.schedule.mon, null);

    const cleared = updateEmployeeUser(db, created.id, { schedule: null });
    assert.equal(cleared.schedule, null);
    assert.equal(getEmployeeWithRights(db, created.id).schedule, null);
  });

  it('rejects inverted working hours', () => {
    const employee = createEmployeeUser(db, { phone: '+998901000042', displayName: 'Смена' });
    assert.throws(
      () => updateEmployeeUser(db, employee.id, { schedule: { mon: { start: '18:00', end: '09:00' } } }),
      /INVALID_EMPLOYEE_SCHEDULE/
    );
  });

  it('saves schedule when promoting a customer', () => {
    const customer = registerCustomer(db, {
      phone: '+998901000043',
      telegramId: 900043,
      firstName: 'Клиент',
    });
    const promoted = convertCustomerToEmployee(db, customer.id, {
      displayName: 'Новый сотрудник',
      schedule: { wed: { start: '11:00', end: '19:00' } },
    });
    assert.equal(promoted.role, 'employee');
    assert.equal(promoted.schedule.wed.start, '11:00');
  });
});
