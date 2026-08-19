const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { createEmployeeUser, linkEmployeeTelegram } = require('../src/db/bot-users-db');
const { createDevice } = require('../src/db/devices');
const { createService } = require('../src/db/services');
const { openDb } = require('../src/db/partners-db');
const { setUsdUzsRate } = require('../src/db/money');
const { addTaskService, createTask, postTask } = require('../src/db/tasks');
const {
  actorOwnsReportJob,
} = require('../src/db/report-jobs');
const { createOrReuseReportJob, createReportWorker } = require('../src/admin/report-worker');
const { buildCommissionReport } = require('../src/db/staff-reports');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-report-jobs-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

function cookieFromSetCookie(headerValue) {
  const raw = headerValue;
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/,(?=\s*[^;=]+=)/);
  const match = list
    .map((part) => String(part).trim())
    .find((part) => part.startsWith('bot_admin_session='));
  return match ? match.split(';')[0] : null;
}

function request(server, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          Accept: 'application/json',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('report jobs', () => {
  let dbPath;
  let db;
  let manager;
  let technician;
  let period;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    setUsdUzsRate(db, 12500);
    manager = createEmployeeUser(db, { phone: '+998901000041', displayName: 'Менеджер' });
    technician = createEmployeeUser(db, { phone: '+998901000042', displayName: 'Техник' });
    const device = createDevice(db, {
      name: 'Терминал',
      cost_amount: 0,
      price_uzs: 100000,
      manager_sale_percent: 10,
      technician_score: 2,
    });
    const service = createService(db, {
      name: 'Настройка',
      cost_amount: 0,
      price_uzs: 50000,
      manager_sale_percent: 20,
      technician_score: 3,
    });
    period = currentPeriod();
    const task = createTask(db, {
      title: 'Установка терминала',
      status: 'done',
      manager_user_id: manager.id,
      technician_user_id: technician.id,
      devices: [{ device_id: device.id, quantity: 1 }],
    });
    addTaskService(db, task.id, { service_id: service.id, quantity: 1 });
    postTask(db, task.id);
  });

  after(() => {
    db.close();
    removeDbFiles(dbPath);
  });

  it('builds a commission job in the background and stores the live report shape', async () => {
    const telegramCalls = [];
    const worker = createReportWorker(db, {
      sendTelegram: async (telegramId, text) => {
        telegramCalls.push({ telegramId, text });
        return { sent: true };
      },
    });
    const actor = { type: 'password' };
    const { job, created } = createOrReuseReportJob(db, {
      type: 'commission',
      input: { from_date: period.fromUnix, to_date: period.toUnix },
      actor,
    });
    assert.equal(created, true);
    assert.equal(job.status, 'pending');

    const finished = await worker.enqueue(job.id);
    assert.equal(finished.status, 'ready');
    const expected = buildCommissionReport(db, {
      fromUnix: period.fromUnix,
      toUnix: period.toUnix,
      viewer: { seeAll: true, userId: null },
    });
    assert.deepEqual(finished.result, expected);
    assert.equal(telegramCalls.length, 0);
  });

  it('builds a technician job with mocked CRM tickets', async () => {
    const worker = createReportWorker(db, {
      fetchAllTickets: async () => [],
      sendTelegram: async () => ({ sent: false, reason: 'no_telegram_id' }),
    });
    const { job } = createOrReuseReportJob(db, {
      type: 'technician',
      input: { from_date: period.fromUnix, to_date: period.toUnix },
      actor: { type: 'password' },
    });
    const finished = await worker.enqueue(job.id);
    assert.equal(finished.status, 'ready');
    assert.ok(Array.isArray(finished.result.rows));
    assert.equal(typeof finished.result.unassigned_ticket_count, 'number');
    assert.ok(finished.result.totals);
  });

  it('reuses an in-flight job with the same actor, type, and params', () => {
    const actor = { type: 'user', userId: manager.id };
    const input = { from_date: period.fromUnix, to_date: period.toUnix };
    const first = createOrReuseReportJob(db, { type: 'finance', input, actor });
    assert.equal(first.created, true);
    const second = createOrReuseReportJob(db, { type: 'finance', input, actor });
    assert.equal(second.created, false);
    assert.equal(second.job.id, first.job.id);
  });

  it('isolates jobs by owner', () => {
    const alice = { type: 'user', userId: manager.id };
    const bob = { type: 'user', userId: technician.id };
    const { job } = createOrReuseReportJob(db, {
      type: 'finance',
      input: { from_date: period.fromUnix, to_date: period.toUnix, extra: 'owner-isolation' },
      actor: alice,
    });
    assert.equal(actorOwnsReportJob(db, job, alice), true);
    assert.equal(actorOwnsReportJob(db, job, bob), false);
    assert.equal(actorOwnsReportJob(db, job, { type: 'password' }), false);
  });

  it('sends Telegram when the actor has a telegram id and skips password admin', async () => {
    const telegramId = 777001;
    linkEmployeeTelegram(db, manager.id, telegramId, { firstName: 'Менеджер' });
    const sent = [];
    const worker = createReportWorker(db, {
      sendTelegram: async (id, text) => {
        sent.push({ id, text });
        return { sent: true };
      },
    });

    const passwordJob = createOrReuseReportJob(db, {
      type: 'commission',
      input: { from_date: period.fromUnix + 1, to_date: period.toUnix },
      actor: { type: 'password' },
    }).job;
    await worker.enqueue(passwordJob.id);
    assert.equal(sent.length, 0);

    const telegramJob = createOrReuseReportJob(db, {
      type: 'commission',
      input: { from_date: period.fromUnix + 2, to_date: period.toUnix },
      actor: { type: 'telegram', telegramId },
    }).job;
    const finished = await worker.enqueue(telegramJob.id);
    assert.equal(finished.status, 'ready');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, telegramId);
    assert.match(sent[0].text, /Баллы техника|Комиссия менеджера/);
    assert.match(sent[0].text, /готов/);
  });
});

describe('report job HTTP API', () => {
  let dbPath;
  let db;
  let server;
  let previousEnv;
  let period;

  before(() => {
    previousEnv = {
      BOT_ADMIN_LOGIN: process.env.BOT_ADMIN_LOGIN,
      BOT_ADMIN_PASSWORD: process.env.BOT_ADMIN_PASSWORD,
    };
    process.env.BOT_ADMIN_LOGIN = 'admin';
    process.env.BOT_ADMIN_PASSWORD = 'test-password';
  });

  after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    if (db) {
      db.close();
      db = null;
    }
    if (dbPath) removeDbFiles(dbPath);
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    setUsdUzsRate(db, 12500);
    period = currentPeriod();
    const { createBotAdminRouter } = require('../src/admin/bot-admin');
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    server = await new Promise((resolve) => {
      const created = http.createServer(app);
      created.listen(0, '127.0.0.1', () => resolve(created));
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    if (db) {
      db.close();
      db = null;
    }
    if (dbPath) removeDbFiles(dbPath);
  });

  async function login(login, password) {
    const res = await request(server, 'POST', '/bot-admin/api/login', {
      body: { login, password },
    });
    assert.equal(res.statusCode, 200);
    const cookie = cookieFromSetCookie(res.headers['set-cookie']);
    assert.ok(cookie);
    return cookie;
  }

  async function waitForJob(cookie, jobId) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const res = await request(server, 'GET', `/bot-admin/api/reports/jobs/${jobId}`, {
        headers: { Cookie: cookie },
      });
      const body = JSON.parse(res.body || '{}');
      if (res.statusCode === 200 && (body.status === 'ready' || body.status === 'failed')) {
        return { ...res, parsed: body };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for report job ${jobId}`);
  }

  it('creates a commission report in the background and returns it when ready', async () => {
    const cookie = await login('admin', 'test-password');
    const created = await request(server, 'POST', '/bot-admin/api/reports/commission', {
      headers: { Cookie: cookie },
      body: { from_date: period.fromUnix, to_date: period.toUnix },
    });
    assert.equal(created.statusCode, 202);
    const createdBody = JSON.parse(created.body);
    assert.ok(createdBody.id);
    assert.equal(createdBody.status, 'pending');
    assert.equal(createdBody.result, null);

    const ready = await waitForJob(cookie, createdBody.id);
    assert.equal(ready.parsed.status, 'ready');
    assert.ok(ready.parsed.result);
    assert.ok(Array.isArray(ready.parsed.result.rows));
    assert.ok(ready.parsed.result.totals);
  });

  it('hides another user\'s report job', async () => {
    createEmployeeUser(db, {
      phone: '+998901000051',
      displayName: 'Алиса',
      adminLogin: 'alice',
      password: 'alice-secret',
      rights: { see_all_report: 1 },
    });
    createEmployeeUser(db, {
      phone: '+998901000052',
      displayName: 'Борис',
      adminLogin: 'boris',
      password: 'boris-secret',
      rights: { see_all_report: 1 },
    });

    const aliceCookie = await login('alice', 'alice-secret');
    const created = await request(server, 'POST', '/bot-admin/api/reports/finance', {
      headers: { Cookie: aliceCookie },
      body: { from_date: period.fromUnix, to_date: period.toUnix },
    });
    assert.equal(created.statusCode, 202);
    const jobId = JSON.parse(created.body).id;

    const borisCookie = await login('boris', 'boris-secret');
    const hidden = await request(server, 'GET', `/bot-admin/api/reports/jobs/${jobId}`, {
      headers: { Cookie: borisCookie },
    });
    assert.equal(hidden.statusCode, 404);

    const own = await request(server, 'GET', `/bot-admin/api/reports/jobs/${jobId}`, {
      headers: { Cookie: aliceCookie },
    });
    assert.equal(own.statusCode, 200);
    assert.equal(JSON.parse(own.body).id, jobId);
  });
});
