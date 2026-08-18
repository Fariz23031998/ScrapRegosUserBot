const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createEmployeeUser } = require('../src/db/bot-users-db');
const {
  createLocation,
  deleteLocation,
  getLocation,
  listLocations,
  listLocationsForViewer,
  updateLocation,
} = require('../src/db/locations');
const { openDb } = require('../src/db/partners-db');
const {
  createPaymentType,
  deletePaymentType,
  listPaymentTypes,
  updatePaymentType,
} = require('../src/db/payment-types');
const { createTask, getTask, listTasks, updateTask } = require('../src/db/tasks');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-locations-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('locations, payment types, and task visibility', () => {
  let dbPath;
  let db;
  let alice;
  let bob;
  let customerId;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    alice = createEmployeeUser(db, { phone: '+998901000001', displayName: 'Алиса' });
    bob = createEmployeeUser(db, { phone: '+998901000002', displayName: 'Борис' });
    const inserted = db
      .prepare(`INSERT INTO bot_users (phone, role) VALUES (?, 'customer')`)
      .run('+998901000003');
    customerId = Number(inserted.lastInsertRowid);
  });

  after(() => {
    db.close();
    removeDbFiles(dbPath);
  });

  it('creates and updates a location with an employee allowlist', () => {
    const created = createLocation(db, {
      name: 'Офис Чиланзар',
      allowed_user_ids: [alice.id],
    });
    assert.equal(created.name, 'Офис Чиланзар');
    assert.deepEqual(created.allowed_user_ids, [alice.id]);
    assert.equal(created.allowed_users[0].name, 'Алиса');

    const updated = updateLocation(db, created.id, {
      name: 'Офис Юнусабад',
      allowed_user_ids: [alice.id, bob.id],
    });
    assert.equal(updated.name, 'Офис Юнусабад');
    assert.deepEqual(updated.allowed_user_ids.sort(), [alice.id, bob.id].sort());
    assert.equal(listLocations(db).some((item) => item.id === created.id), true);
  });

  it('rejects empty allowlists and non-employee users', () => {
    assert.throws(() => createLocation(db, { name: 'Пустая', allowed_user_ids: [] }), /INVALID_LOCATION_USERS/);
    assert.throws(
      () => createLocation(db, { name: 'Клиент', allowed_user_ids: [customerId] }),
      /INVALID_LOCATION_USERS/
    );
    assert.throws(() => createLocation(db, { name: '  ' }), /INVALID_LOCATION_NAME/);
  });

  it('creates, updates, and deletes payment types', () => {
    const created = createPaymentType(db, { name: 'Наличные', currency: 'UZS' });
    assert.equal(created.name, 'Наличные');
    assert.equal(created.currency, 'UZS');
    const updated = updatePaymentType(db, created.id, { name: 'CLICK', currency: 'USD' });
    assert.equal(updated.name, 'CLICK');
    assert.equal(updated.currency, 'USD');
    assert.equal(listPaymentTypes(db).some((item) => item.id === created.id), true);
    assert.equal(deletePaymentType(db, created.id), true);
    assert.equal(listPaymentTypes(db).some((item) => item.id === created.id), false);
    assert.throws(() => createPaymentType(db, { name: '' }), /INVALID_PAYMENT_TYPE_NAME/);
    assert.throws(
      () => createPaymentType(db, { name: 'Payme', currency: 'EUR' }),
      /INVALID_PAYMENT_TYPE_CURRENCY/
    );
  });

  it('requires a location the viewer can access when creating a task', () => {
    const office = createLocation(db, { name: 'Сервис', allowed_user_ids: [alice.id] });
    const warehouse = createLocation(db, { name: 'Склад', allowed_user_ids: [bob.id] });
    const aliceViewer = { seeAll: false, userId: alice.id };

    const created = createTask(
      db,
      { title: 'Установка Alice', action: 'install', location_id: office.id },
      { requireLocation: true, viewer: aliceViewer }
    );
    assert.equal(created.location_id, office.id);
    assert.equal(created.location.name, 'Сервис');

    assert.throws(
      () =>
        createTask(
          db,
          { title: 'Чужой склад', action: 'install', location_id: warehouse.id },
          { requireLocation: true, viewer: aliceViewer }
        ),
      /INVALID_TASK_LOCATION/
    );
    assert.throws(
      () => createTask(db, { title: 'Без локации', action: 'install' }, { requireLocation: true, viewer: aliceViewer }),
      /INVALID_TASK_LOCATION/
    );
  });

  it('hides tasks for locations the viewer cannot access and keeps null-location tasks visible', () => {
    const office = createLocation(db, { name: 'Филиал A', allowed_user_ids: [alice.id] });
    const warehouse = createLocation(db, { name: 'Филиал B', allowed_user_ids: [bob.id] });
    const aliceTask = createTask(db, { title: 'Задача Алисы', action: 'install', location_id: office.id });
    const bobTask = createTask(db, { title: 'Задача Бориса', action: 'install', location_id: warehouse.id });
    const legacy = createTask(db, { title: 'Старая задача', action: 'install' });

    const aliceViewer = { seeAll: false, userId: alice.id };
    const listed = listTasks(db, { viewer: aliceViewer, limit: 100 });
    assert.equal(listed.tasks.some((task) => task.id === aliceTask.id), true);
    assert.equal(listed.tasks.some((task) => task.id === legacy.id), true);
    assert.equal(listed.tasks.some((task) => task.id === bobTask.id), false);

    assert.equal(getTask(db, aliceTask.id, aliceViewer)?.id, aliceTask.id);
    assert.equal(getTask(db, bobTask.id, aliceViewer), null);
    assert.equal(getTask(db, bobTask.id, { seeAll: true })?.id, bobTask.id);

    const all = listTasks(db, { viewer: { seeAll: true }, limit: 100 });
    assert.equal(all.tasks.some((task) => task.id === bobTask.id), true);

    const picker = listLocationsForViewer(db, aliceViewer).map((item) => item.id);
    assert.equal(picker.includes(office.id), true);
    assert.equal(picker.includes(warehouse.id), false);
  });

  it('nulls task location when the location is deleted', () => {
    const office = createLocation(db, { name: 'Временная', allowed_user_ids: [alice.id] });
    const task = createTask(db, { title: 'После удаления', action: 'install', location_id: office.id });
    assert.equal(deleteLocation(db, office.id), true);
    assert.equal(getLocation(db, office.id), null);
    assert.equal(getTask(db, task.id).location_id, null);
  });

  it('does not let a restricted viewer move a task onto a hidden location', () => {
    const office = createLocation(db, { name: 'Доступная', allowed_user_ids: [alice.id] });
    const warehouse = createLocation(db, { name: 'Скрытая', allowed_user_ids: [bob.id] });
    const task = createTask(db, { title: 'Перенос', action: 'install', location_id: office.id });
    const aliceViewer = { seeAll: false, userId: alice.id };

    assert.throws(
      () =>
        updateTask(
          db,
          task.id,
          { location_id: warehouse.id },
          { requireLocation: true, viewer: aliceViewer }
        ),
      /INVALID_TASK_LOCATION/
    );
    assert.equal(getTask(db, task.id).location_id, office.id);
  });
});
