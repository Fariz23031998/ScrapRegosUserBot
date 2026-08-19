const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDb } = require('../src/db/partners-db');
const { createService } = require('../src/db/services');
const { createDevice } = require('../src/db/devices');
const { listPaymentTypes } = require('../src/db/payment-types');
const { createTaskPayment } = require('../src/db/task-payments');
const {
  addTaskDevice,
  addTaskService,
  advanceTaskStatus,
  createTask,
  deleteTask,
  getTask,
  postTask,
  unpostTask,
  updateTask,
  updateTaskService,
} = require('../src/db/tasks');
const { refundTaskLine } = require('../src/db/task-refunds');
const { ADMIN_PERMISSION_KEYS, RIGHTS } = require('../src/db/user-rights');
const { DEFAULT_RIGHTS } = require('../src/db/bot-users-db');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-task-posting-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('task posting and status', () => {
  let dbPath;
  let db;
  let cashUzs;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    cashUzs = listPaymentTypes(db).find((item) => item.code === 'cash');
  });

  after(() => {
    db.close();
    removeDbFiles(dbPath);
  });

  it('exposes tasks_post, tasks_unpost, tasks_status, tasks_manager, and tasks_technician permissions and user_rights columns', () => {
    const cols = db.prepare('PRAGMA table_info(user_rights)').all();
    for (const key of ['tasks_post', 'tasks_unpost', 'tasks_status', 'tasks_manager', 'tasks_technician']) {
      assert.ok(RIGHTS[key]);
      assert.equal(DEFAULT_RIGHTS[key], 0);
      assert.ok(ADMIN_PERMISSION_KEYS.includes(key));
      assert.ok(cols.some((col) => col.name === key));
    }
  });

  it('posts and unposts a task', () => {
    const created = createTask(db, { title: 'Проведение', devices: [] });
    assert.equal(created.posted, false);
    const posted = postTask(db, created.id);
    assert.equal(posted.posted, true);
    const unposted = unpostTask(db, created.id);
    assert.equal(unposted.posted, false);
  });

  it('advances status one step and rejects backward or skipped changes', () => {
    const created = createTask(db, { title: 'Статусы', devices: [] });
    assert.equal(created.status, 'new');

    const inProgress = advanceTaskStatus(db, created.id);
    assert.equal(inProgress.status, 'in_progress');
    const done = advanceTaskStatus(db, created.id);
    assert.equal(done.status, 'done');
    assert.throws(() => advanceTaskStatus(db, created.id), /INVALID_TASK_STATUS_TRANSITION/);

    const other = createTask(db, { title: 'Назад нельзя', devices: [] });
    assert.throws(
      () => updateTask(db, other.id, { title: 'Назад нельзя', status: 'done' }),
      /INVALID_TASK_STATUS_TRANSITION/
    );
    updateTask(db, other.id, { title: 'Назад нельзя', status: 'in_progress' });
    assert.throws(
      () => updateTask(db, other.id, { title: 'Назад нельзя', status: 'new' }),
      /INVALID_TASK_STATUS_TRANSITION/
    );
    const reopened = updateTask(db, done.id, { status: 'new' }, { allowAnyStatus: true });
    assert.equal(reopened.status, 'new');
  });

  it('locks the task when it is posted', () => {
    const service = createService(db, {
      name: 'Блокировка корзины',
      cost_amount: 0,
      cost_currency: 'UZS',
      price_uzs: 10000,
    });
    const created = createTask(db, { title: 'Корзина закрыта', devices: [] });
    const withLine = addTaskService(db, created.id, { service_id: service.id, quantity: 1 });
    const lineId = withLine.services[0].id;
    postTask(db, created.id);

    assert.throws(() => addTaskService(db, created.id, { service_id: service.id }), /TASK_CART_LOCKED/);
    assert.throws(() => updateTaskService(db, created.id, lineId, { quantity: 2 }), /TASK_CART_LOCKED/);
    assert.throws(() => updateTask(db, created.id, { title: 'Нельзя' }), /TASK_CART_LOCKED/);
    assert.throws(() => advanceTaskStatus(db, created.id), /TASK_CART_LOCKED/);
    assert.throws(() => deleteTask(db, created.id), /TASK_CART_LOCKED/);
    unpostTask(db, created.id);
    const updated = updateTaskService(db, created.id, lineId, { quantity: 2 });
    assert.equal(updated.services[0].quantity, 2);
    const renamed = updateTask(db, created.id, { title: 'Можно' });
    assert.equal(renamed.title, 'Можно');
  });

  it('deletes refunds when unposting with confirmation', () => {
    const service = createService(db, {
      name: 'Возврат блокирует отмену',
      cost_amount: 0,
      cost_currency: 'UZS',
      price_uzs: 15000,
    });
    const device = createDevice(db, {
      name: 'Камера',
      cost_amount: 0,
      cost_currency: 'UZS',
      price_uzs: 40000,
    });
    const created = createTask(db, { title: 'Есть возврат', devices: [] });
    addTaskService(db, created.id, { service_id: service.id });
    addTaskDevice(db, created.id, { device_id: device.id, action: 'install', quantity: 1 });
    createTaskPayment(db, created.id, { payment_type_id: cashUzs.id, amount: 55000 });
    advanceTaskStatus(db, created.id);
    advanceTaskStatus(db, created.id);
    postTask(db, created.id);
    const task = getTask(db, created.id);
    refundTaskLine(db, created.id, {
      kind: 'service',
      line_id: task.services[0].id,
      quantity: 1,
      payment_type_id: cashUzs.id,
      amount: 15000,
      currency: 'UZS',
    });
    refundTaskLine(db, created.id, {
      kind: 'device',
      line_id: task.devices[0].id,
      quantity: 1,
    });
    assert.throws(() => unpostTask(db, created.id), /TASK_HAS_REFUNDS/);
    assert.equal(getTask(db, created.id).posted, true);
    assert.equal(getTask(db, created.id).refunds.length, 2);

    const unposted = unpostTask(db, created.id, null, { deleteRefunds: true });
    assert.equal(unposted.posted, false);
    assert.equal(unposted.refunds.length, 0);
    assert.equal(unposted.services.length, 1);
    assert.equal(unposted.devices.length, 1);
    assert.equal(unposted.payments.length, 1);
    assert.equal(unposted.payments[0].amount, 55000);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM task_refunds WHERE task_id = ?').get(created.id).count,
      0
    );
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS count FROM task_payments WHERE task_id = ? AND kind = ?')
        .get(created.id, 'refund').count,
      0
    );
  });
});
