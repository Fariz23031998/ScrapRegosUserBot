const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createEmployeeUser, setBotUserRegosLink } = require('../src/db/bot-users-db');
const { createDevice } = require('../src/db/devices');
const { createService } = require('../src/db/services');
const { openDb } = require('../src/db/partners-db');
const { setUsdUzsRate } = require('../src/db/money');
const { addTaskService, createTask, postTask, updateTaskDevice } = require('../src/db/tasks');
const {
  buildCommissionReport,
  buildTechnicianReport,
  unixSecondsToSqliteUtc,
} = require('../src/db/staff-reports');
const { countTicketsByResponsible, buildDurationSummary } = require('../src/admin/ticket-duration');
const { ADMIN_PERMISSION_KEYS } = require('../src/db/user-rights');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-staff-reports-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

function currentPeriod() {
  const now = Math.floor(Date.now() / 1000);
  return { fromUnix: now - 24 * 3600, toUnix: now + 3600 };
}

describe('staff reports', () => {
  let dbPath;
  let db;
  let manager;
  let technician;
  let device;
  let service;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    setUsdUzsRate(db, 12500);
    manager = createEmployeeUser(db, { phone: '+998901000021', displayName: 'Менеджер' });
    technician = createEmployeeUser(db, { phone: '+998901000022', displayName: 'Техник' });
    setBotUserRegosLink(db, technician.id, { regosUserId: 77, regosFullName: 'Техник REGOS' });
    device = createDevice(db, {
      name: 'Терминал',
      cost_amount: 0,
      price_uzs: 100000,
      manager_sale_percent: 10,
      technician_score: 2,
    });
    service = createService(db, {
      name: 'Настройка',
      cost_amount: 0,
      price_uzs: 50000,
      manager_sale_percent: 20,
      technician_score: 3,
    });
  });

  after(() => {
    db.close();
    removeDbFiles(dbPath);
  });

  it('exposes see_all_report as an admin permission', () => {
    assert.ok(ADMIN_PERMISSION_KEYS.includes('see_all_report'));
  });

  it('converts unix seconds to sqlite UTC datetime', () => {
    assert.equal(unixSecondsToSqliteUtc(1704067200), '2024-01-01 00:00:00');
  });

  it('sums commission and technician score from done posted tasks independently', () => {
    const task = createTask(db, {
      title: 'Установка терминала',
      status: 'done',
      manager_user_id: manager.id,
      technician_user_id: technician.id,
      devices: [{ device_id: device.id, quantity: 2 }],
    });
    addTaskService(db, task.id, { service_id: service.id, quantity: 1 });
    postTask(db, task.id);

    const commission = buildCommissionReport(db, currentPeriod());
    const scores = buildTechnicianReport(db, currentPeriod());
    const managerRow = commission.rows.find((row) => row.user_id === manager.id);
    const technicianRow = scores.rows.find((row) => row.user_id === technician.id);

    assert.ok(managerRow);
    assert.equal(managerRow.manager_task_count, 1);
    assert.equal(managerRow.commission_uzs, 30000);
    assert.equal(managerRow.commission_usd, 2.4);
    assert.equal(managerRow.technician_task_count, undefined);
    assert.equal(managerRow.ticket_count, undefined);

    assert.ok(technicianRow);
    assert.equal(technicianRow.technician_task_count, 1);
    assert.equal(technicianRow.technician_task_score, 7);
    assert.equal(technicianRow.ticket_count, 0);
    assert.equal(technicianRow.commission_uzs, undefined);
    assert.equal(scores.rows.find((row) => row.user_id === manager.id), undefined);
    assert.equal(commission.rows.find((row) => row.user_id === technician.id), undefined);
  });

  it('ignores new and unposted tasks', () => {
    const commissionBefore = buildCommissionReport(db, currentPeriod());
    const scoresBefore = buildTechnicianReport(db, currentPeriod());
    const managerBefore = commissionBefore.rows.find((row) => row.user_id === manager.id);
    const technicianBefore = scoresBefore.rows.find((row) => row.user_id === technician.id);

    createTask(db, {
      title: 'Черновик',
      status: 'new',
      manager_user_id: manager.id,
      technician_user_id: technician.id,
      devices: [{ device_id: device.id }],
    });
    const unposted = createTask(db, {
      title: 'Готова но не проведена',
      status: 'done',
      manager_user_id: manager.id,
      technician_user_id: technician.id,
      devices: [{ device_id: device.id }],
    });
    assert.equal(unposted.posted, false);

    const commissionAfter = buildCommissionReport(db, currentPeriod());
    const scoresAfter = buildTechnicianReport(db, currentPeriod());
    const managerAfter = commissionAfter.rows.find((row) => row.user_id === manager.id);
    const technicianAfter = scoresAfter.rows.find((row) => row.user_id === technician.id);
    assert.equal(managerAfter.manager_task_count, managerBefore.manager_task_count);
    assert.equal(managerAfter.commission_uzs, managerBefore.commission_uzs);
    assert.equal(technicianAfter.technician_task_count, technicianBefore.technician_task_count);
    assert.equal(technicianAfter.technician_task_score, technicianBefore.technician_task_score);
  });

  it('applies percent discount to manager commission without changing technician score formula', () => {
    const scoresBefore = buildTechnicianReport(db, currentPeriod());
    const technicianBefore = scoresBefore.rows.find((row) => row.user_id === technician.id);
    const task = createTask(db, {
      title: 'Со скидкой',
      status: 'done',
      manager_user_id: manager.id,
      technician_user_id: technician.id,
      devices: [{ device_id: device.id, quantity: 1 }],
    });
    updateTaskDevice(db, task.id, task.devices[0].id, {
      discount_type: 'percent',
      discount_value: 10,
    });
    postTask(db, task.id);

    const commission = buildCommissionReport(db, currentPeriod());
    const scores = buildTechnicianReport(db, currentPeriod());
    const managerRow = commission.rows.find((row) => row.user_id === manager.id);
    const technicianRow = scores.rows.find((row) => row.user_id === technician.id);
    assert.equal(managerRow.commission_uzs, 39000);
    assert.equal(technicianRow.technician_task_score, technicianBefore.technician_task_score + 2);
  });

  it('adds ticket counts only to the technician report', () => {
    const commissionBefore = buildCommissionReport(db, currentPeriod());
    const report = buildTechnicianReport(db, {
      ...currentPeriod(),
      ticketsByRegosUserId: new Map([
        [77, 4],
        [999, 2],
      ]),
      unassignedTicketCount: 1,
    });
    const technicianRow = report.rows.find((row) => row.user_id === technician.id);
    assert.equal(technicianRow.ticket_count, 4);
    assert.equal(report.unassigned_ticket_count, 3);
    assert.equal(report.totals.ticket_count, 4);

    const commissionAfter = buildCommissionReport(db, currentPeriod());
    const managerBefore = commissionBefore.rows.find((row) => row.user_id === manager.id);
    const managerAfter = commissionAfter.rows.find((row) => row.user_id === manager.id);
    assert.equal(managerAfter.commission_uzs, managerBefore.commission_uzs);
    assert.equal(managerAfter.manager_task_count, managerBefore.manager_task_count);
    assert.equal(commissionAfter.unassigned_ticket_count, undefined);
  });

  it('excludes tasks outside the created_at period', () => {
    const oldTask = createTask(db, {
      title: 'Старая задача',
      status: 'done',
      manager_user_id: manager.id,
      devices: [{ device_id: device.id }],
    });
    postTask(db, oldTask.id);
    db.prepare(`UPDATE tasks SET created_at = '2020-01-01 00:00:00' WHERE id = ?`).run(oldTask.id);

    const commission = buildCommissionReport(db, currentPeriod());
    const managerRow = commission.rows.find((row) => row.user_id === manager.id);
    assert.equal(managerRow.manager_task_count, 2);
  });
});

describe('ticket duration counting for reports', () => {
  it('counts messages and drops short or unknown-duration calls', () => {
    const tickets = [
      { id: 1, channel_id: 'chat', responsible_user_id: 10, sla_breached: false, rating: null, fields: [] },
      {
        id: 2,
        channel_id: 'phone',
        responsible_user_id: 10,
        sla_breached: false,
        rating: null,
        fields: [{ key: 'field_recording_link', value: 'http://rofeev.7x.uz/recordings/2.wav' }],
      },
      {
        id: 3,
        channel_id: 'phone',
        responsible_user_id: 11,
        sla_breached: false,
        rating: null,
        fields: [{ key: 'field_recording_link', value: 'http://rofeev.7x.uz/recordings/3.wav' }],
      },
      { id: 4, channel_id: 'phone', responsible_user_id: null, sla_breached: false, rating: null, fields: [] },
    ];
    const { upsertTicketRecording } = require('../src/db/ticket-recordings');
    const durationDbPath = path.join(os.tmpdir(), `staff-report-duration-${process.pid}-${Date.now()}.db`);
    const db = openDb(durationDbPath);
    try {
      upsertTicketRecording(db, {
        ticketId: 2,
        recordingUrl: 'http://rofeev.7x.uz/recordings/2.wav',
        durationSeconds: 40,
      });
      upsertTicketRecording(db, {
        ticketId: 3,
        recordingUrl: 'http://rofeev.7x.uz/recordings/3.wav',
        durationSeconds: 8,
      });
      const counted = countTicketsByResponsible(tickets, {
        minimumCallDuration: 10,
        channelSettings: [
          { channel_id: 'chat', interaction_mode: 'message_only' },
          { channel_id: 'phone', interaction_mode: 'call' },
        ],
        db,
      });
      assert.equal(counted.byResponsible.get(10), 2);
      assert.equal(counted.byResponsible.has(11), false);
      assert.equal(counted.unassigned, 0);
      assert.equal(counted.total, 2);
    } finally {
      db.close();
      removeDbFiles(durationDbPath);
    }
  });

  it('drops duplicate tickets in the interval window', () => {
    const tickets = [
      { id: 1, client_id: 5, created_date: 1000, last_update: 1000, responsible_user_id: 10 },
      { id: 2, client_id: 5, created_date: 1400, last_update: 1400, responsible_user_id: 10 },
      { id: 3, client_id: 6, created_date: 2000, last_update: 2000, responsible_user_id: 11 },
    ];
    const counted = countTicketsByResponsible(tickets, {
      withoutDuplicates: true,
      duplicateIntervalMinutes: 10,
    });
    assert.equal(counted.byResponsible.get(10), 1);
    assert.equal(counted.byResponsible.get(11), 1);
    assert.equal(counted.total, 2);
  });

  it('keeps buildDurationSummary compatible with the tickets list', () => {
    const summary = buildDurationSummary(
      [
        { id: 1, channel_id: 'chat', sla_breached: true, rating: 5, fields: [] },
        {
          id: 2,
          channel_id: 'phone',
          sla_breached: false,
          rating: null,
          fields: [{ key: 'field_recording_link', value: 'http://rofeev.7x.uz/recordings/2.wav' }],
        },
      ],
      [
        { channel_id: 'chat', interaction_mode: 'message_only' },
        { channel_id: 'phone', interaction_mode: 'call' },
      ]
    );
    assert.deepEqual(summary.base, { count: 1, slaBreached: 1, rated: 1 });
    assert.equal(summary.calls.length, 1);
    assert.equal(summary.calls[0].id, 2);
    assert.equal(summary.calls[0].hasRecording, true);
  });
});
