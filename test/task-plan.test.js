const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createEmployeeUser } = require('../src/db/bot-users-db');
const { openDb } = require('../src/db/partners-db');
const { createTask, updateTask } = require('../src/db/tasks');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-task-plan-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('task planned start and finish', () => {
  let dbPath;
  let db;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    createEmployeeUser(db, { phone: '+998901000031', displayName: 'Планировщик' });
  });

  after(() => {
    db.close();
    removeDbFiles(dbPath);
  });

  it('persists planned start and finish on create and update', () => {
    const start = '2026-08-24T09:00:00.000Z';
    const finish = '2026-08-24T12:30:00.000Z';
    const created = createTask(db, {
      title: 'С планом',
      action: 'install',
      planned_start_at: start,
      planned_finish_at: finish,
    });
    assert.equal(created.planned_start_at, start);
    assert.equal(created.planned_finish_at, finish);

    const updated = updateTask(db, created.id, {
      planned_start_at: '2026-08-24T10:00:00.000Z',
      planned_finish_at: '2026-08-24T13:00:00.000Z',
    });
    assert.equal(updated.planned_start_at, '2026-08-24T10:00:00.000Z');
    assert.equal(updated.planned_finish_at, '2026-08-24T13:00:00.000Z');
  });

  it('allows clearing planned times', () => {
    const created = createTask(db, {
      title: 'Очистка плана',
      action: 'repair',
      planned_start_at: '2026-08-24T09:00:00.000Z',
      planned_finish_at: '2026-08-24T11:00:00.000Z',
    });
    const updated = updateTask(db, created.id, {
      planned_start_at: null,
      planned_finish_at: '',
    });
    assert.equal(updated.planned_start_at, null);
    assert.equal(updated.planned_finish_at, null);
  });

  it('rejects finish before start', () => {
    assert.throws(
      () =>
        createTask(db, {
          title: 'Перепутано',
          action: 'install',
          planned_start_at: '2026-08-24T12:00:00.000Z',
          planned_finish_at: '2026-08-24T11:00:00.000Z',
        }),
      /INVALID_TASK_PLAN_RANGE/
    );
  });

  it('rejects invalid planned datetime', () => {
    assert.throws(
      () =>
        createTask(db, {
          title: 'Плохая дата',
          action: 'install',
          planned_start_at: 'not-a-date',
        }),
      /INVALID_TASK_PLAN/
    );
  });
});
