const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDb } = require('../src/db/partners-db');
const { createDevice } = require('../src/db/devices');
const { addTaskDevice, createTask, getTask, updateTaskDevice } = require('../src/db/tasks');
const { setUsdUzsRate } = require('../src/db/money');
const {
  listSerialsForLine,
  markSerialsPrinted,
  formatSerialCode,
} = require('../src/db/task-device-serials');
const { createPrintJob, listPendingPrintJobs, markPrintJobResult } = require('../src/db/print-jobs');
const { listPrintTemplates, updatePrintTemplate } = require('../src/db/print-templates');
const { enqueueSerialLabelsForTask, enqueueTaskDocument } = require('../src/print/print-dispatch');
const { createTaskDeviceReturn } = require('../src/db/task-device-returns');
const { postTask, advanceTaskStatus } = require('../src/db/tasks');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-print-serials-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('task device serials and print jobs', () => {
  let dbPath;
  let db;
  let device;

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
  });

  after(() => {
    db.close();
    removeDbFiles(dbPath);
  });

  it('creates one serial per device unit', () => {
    const created = createTask(db, { title: 'Продажа', action: 'sale', devices: [] });
    addTaskDevice(db, created.id, { device_id: device.id, quantity: 2 });
    const task = getTask(db, created.id);
    assert.equal(task.devices[0].serials.length, 2);
    assert.match(task.devices[0].serials[0].code, /^SR\d{8}$/);
    assert.equal(task.devices[0].serials[0].code, formatSerialCode(task.devices[0].serials[0].id));
  });

  it('adds serials when quantity increases', () => {
    const created = createTask(db, { title: 'Количество плюс', action: 'sale', devices: [] });
    addTaskDevice(db, created.id, { device_id: device.id, quantity: 1 });
    const lineId = getTask(db, created.id).devices[0].id;
    updateTaskDevice(db, created.id, lineId, { quantity: 3 });
    assert.equal(getTask(db, created.id).devices[0].serials.length, 3);
  });

  it('refuses to drop printed serials', () => {
    const created = createTask(db, { title: 'Печать серийника', action: 'sale', devices: [] });
    addTaskDevice(db, created.id, { device_id: device.id, quantity: 2 });
    const task = getTask(db, created.id);
    markSerialsPrinted(db, [task.devices[0].serials[0].id, task.devices[0].serials[1].id]);
    assert.throws(
      () => updateTaskDevice(db, created.id, task.devices[0].id, { quantity: 1 }),
      /SERIALS_LOCKED/
    );
  });

  it('seeds print templates and stores jobs', () => {
    const templates = listPrintTemplates(db);
    assert.equal(templates.length, 3);
    assert.ok(templates.every((item) => item.html.includes('{{')));
    const updated = updatePrintTemplate(db, 'label', { html: templates[0].html });
    assert.equal(updated.version, 2);

    const job = createPrintJob(db, {
      kind: 'label',
      printer_name: 'Warehouse labels',
      data: { serial: 'SR00000001', device_name: 'Касса' },
    });
    assert.equal(job.status, 'pending');
    assert.equal(job.printerName, 'Warehouse labels');
    assert.equal(listPendingPrintJobs(db).length >= 1, true);
    markPrintJobResult(db, job.id, true);
    assert.equal(listPendingPrintJobs(db).some((item) => item.id === job.id), false);
  });

  it('enqueues label jobs from a task', () => {
    const created = createTask(db, { title: 'Этикетки', action: 'sale', devices: [] });
    addTaskDevice(db, created.id, { device_id: device.id, quantity: 1 });
    const task = getTask(db, created.id);
    const jobs = enqueueSerialLabelsForTask(db, task, null, { printer_name: 'Warehouse labels' });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].kind, 'label');
    assert.equal(jobs[0].printerName, 'Warehouse labels');
    assert.equal(jobs[0].data.serial, task.devices[0].serials[0].code);
    const receipt = enqueueTaskDocument(db, getTask(db, created.id), 'receipt', {
      printer_name: 'Front desk receipt',
    });
    assert.equal(receipt.kind, 'receipt');
    assert.equal(receipt.printerName, 'Front desk receipt');
    assert.match(receipt.data.total, /UZS/);
  });

  it('consumes serials on repair return', () => {
    const created = createTask(db, { title: 'Ремонт серий', action: 'repair', devices: [] });
    addTaskDevice(db, created.id, { device_id: device.id, quantity: 2 });
    advanceTaskStatus(db, created.id);
    advanceTaskStatus(db, created.id);
    postTask(db, created.id);
    const task = getTask(db, created.id);
    const result = createTaskDeviceReturn(db, {
      device_line_id: task.devices[0].id,
      quantity: 1,
    });
    assert.equal(result.serials.length, 1);
    assert.ok(result.serials[0].returned_at);
    assert.equal(listSerialsForLine(db, task.devices[0].id).filter((item) => item.returned_at).length, 1);
  });
});
