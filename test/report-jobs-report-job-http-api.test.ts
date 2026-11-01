import type { Unchecked } from '../src/types/unchecked';
import type { Response } from 'express';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { createEmployeeUser, linkEmployeeTelegram } from '../src/db/bot-users-db';
import { createDevice } from '../src/db/devices';
import { createService } from '../src/db/services';
import { openDb } from '../src/db/partners-db';
import { setUsdUzsRate } from '../src/db/money';
import { addTaskService, createTask, postTask } from '../src/db/tasks';
import { actorOwnsReportJob, deleteReportJob, getReportJob, listReportJobsForActor, presentReportJob } from '../src/db/report-jobs';
import { buildReportPageUrl, createOrReuseReportJob, createReportWorker } from '../src/admin/report-worker';
import { buildCommissionReport } from '../src/db/staff-reports';

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-report-jobs-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
}

function removeDbFiles(dbPath?: any) {
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

function cookieFromSetCookie(headerValue?: any) {
  const raw = headerValue;
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/,(?=\s*[^;=]+=)/);
  const match = list
    .map((part?: any) => String(part).trim())
    .find((part?: any) => part.startsWith('bot_admin_session='));
  return match ? match.split(';')[0] : null;
}

function request(server: any, method: any, urlPath: any, { headers = {}, body = null }: Unchecked = {}) {
  return new Promise<any>((resolve?: any, reject?: any) => {
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
      (res: any) => {
        const chunks: any[] = [];
        res.on('data', (chunk?: any) => chunks.push(chunk));
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


describe('report job HTTP API', () => {
  let dbPath: any;
  let db: any;
  let server: any;
  let previousEnv: any;
  let period: any;

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
      else process.env[key] = value as any;
    }
  });

  beforeEach(async () => {
    if (server) {
      await new Promise<any>((resolve?: any) => server.close(resolve));
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
    const { createBotAdminRouter } = (require('../src/admin/bot-admin') as typeof import('../src/admin/bot-admin'));
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    server = await new Promise<any>((resolve?: any) => {
      const created = http.createServer(app);
      created.listen(0, '127.0.0.1', () => resolve(created));
    });
  });

  after(async () => {
    if (server) {
      await new Promise<any>((resolve?: any) => server.close(resolve));
      server = null;
    }
    if (db) {
      db.close();
      db = null;
    }
    if (dbPath) removeDbFiles(dbPath);
  });

  async function login(login?: any, password?: any) {
    const res = await request(server, 'POST', '/bot-admin/api/login', {
      body: { login, password },
    });
    assert.equal(res.statusCode, 200);
    const cookie = cookieFromSetCookie(res.headers['set-cookie']);
    assert.ok(cookie);
    return cookie;
  }

  async function waitForJob(cookie?: any, jobId?: any) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const res = await request(server, 'GET', `/bot-admin/api/reports/jobs/${jobId}`, {
        headers: { Cookie: cookie },
      });
      const body = JSON.parse(res.body || '{}');
      if (res.statusCode === 200 && (body.status === 'ready' || body.status === 'failed')) {
        return { ...res, parsed: body };
      }
      await new Promise<any>((resolve?: any) => setTimeout(resolve, 50));
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
    assert.ok(ready.parsed.params);
    assert.equal(ready.parsed.params.from_date, period.fromUnix);
    assert.equal(ready.parsed.params.to_date, period.toUnix);
    assert.equal(ready.parsed.params.viewer, undefined);
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

  it('lets the owner delete a report and hides it from others', async () => {
    createEmployeeUser(db, {
      phone: '+998901000071',
      displayName: 'Елена',
      adminLogin: 'elena',
      password: 'elena-secret',
      rights: { see_all_report: 1 },
    });
    createEmployeeUser(db, {
      phone: '+998901000072',
      displayName: 'Игорь',
      adminLogin: 'igor',
      password: 'igor-secret',
      rights: { see_all_report: 1 },
    });

    const elenaCookie = await login('elena', 'elena-secret');
    const created = await request(server, 'POST', '/bot-admin/api/reports/commission', {
      headers: { Cookie: elenaCookie },
      body: { from_date: period.fromUnix, to_date: period.toUnix },
    });
    assert.equal(created.statusCode, 202);
    const jobId = JSON.parse(created.body).id;

    const igorCookie = await login('igor', 'igor-secret');
    const forbidden = await request(server, 'DELETE', `/bot-admin/api/reports/jobs/${jobId}`, {
      headers: { Cookie: igorCookie },
    });
    assert.equal(forbidden.statusCode, 404);

    const stillThere = await request(server, 'GET', `/bot-admin/api/reports/jobs/${jobId}`, {
      headers: { Cookie: elenaCookie },
    });
    assert.equal(stillThere.statusCode, 200);

    const deleted = await request(server, 'DELETE', `/bot-admin/api/reports/jobs/${jobId}`, {
      headers: { Cookie: elenaCookie },
    });
    assert.equal(deleted.statusCode, 200);
    assert.equal(JSON.parse(deleted.body).ok, true);

    const missing = await request(server, 'GET', `/bot-admin/api/reports/jobs/${jobId}`, {
      headers: { Cookie: elenaCookie },
    });
    assert.equal(missing.statusCode, 404);
  });

  it('lists only the current user\'s jobs newest first without results', async () => {
    createEmployeeUser(db, {
      phone: '+998901000061',
      displayName: 'Катя',
      adminLogin: 'katya',
      password: 'katya-secret',
      rights: { see_all_report: 1 },
    });
    createEmployeeUser(db, {
      phone: '+998901000062',
      displayName: 'Дима',
      adminLogin: 'dima',
      password: 'dima-secret',
      rights: { see_all_report: 1 },
    });

    const katyaCookie = await login('katya', 'katya-secret');
    const first = await request(server, 'POST', '/bot-admin/api/reports/finance', {
      headers: { Cookie: katyaCookie },
      body: { from_date: period.fromUnix, to_date: period.toUnix },
    });
    const second = await request(server, 'POST', '/bot-admin/api/reports/commission', {
      headers: { Cookie: katyaCookie },
      body: { from_date: period.fromUnix + 60, to_date: period.toUnix },
    });
    assert.equal(first.statusCode, 202);
    assert.equal(second.statusCode, 202);
    const firstId = JSON.parse(first.body).id;
    const secondId = JSON.parse(second.body).id;

    const dimaCookie = await login('dima', 'dima-secret');
    await request(server, 'POST', '/bot-admin/api/reports/finance', {
      headers: { Cookie: dimaCookie },
      body: { from_date: period.fromUnix + 120, to_date: period.toUnix },
    });

    const listed = await request(server, 'GET', '/bot-admin/api/reports/jobs?limit=25', {
      headers: { Cookie: katyaCookie },
    });
    assert.equal(listed.statusCode, 200);
    const body = JSON.parse(listed.body);
    assert.equal(body.total, 2);
    assert.equal(body.jobs.length, 2);
    assert.deepEqual(body.jobs.map((job?: any) => job.id), [secondId, firstId]);
    for (const job of body.jobs) {
      assert.equal(Object.hasOwn(job, 'result'), false);
      assert.ok(job.params);
      assert.equal(job.params.viewer, undefined);
    }

    const financeListed = await request(server, 'GET', '/bot-admin/api/reports/jobs?type=finance', {
      headers: { Cookie: katyaCookie },
    });
    const financeBody = JSON.parse(financeListed.body);
    assert.equal(financeBody.total, 1);
    assert.equal(financeBody.jobs[0].id, firstId);
    assert.equal(financeBody.jobs[0].type, 'finance');

    const dimaListed = await request(server, 'GET', '/bot-admin/api/reports/jobs', {
      headers: { Cookie: dimaCookie },
    });
    assert.equal(JSON.parse(dimaListed.body).total, 1);
  });
});
