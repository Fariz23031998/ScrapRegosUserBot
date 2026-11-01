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


describe('report jobs', () => {
  let dbPath: any;
  let db: any;
  let manager: any;
  let technician: any;
  let period: any;

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
      devices: [{ device_id: device!.id, quantity: 1 }],
    });
    addTaskService(db, task!.id, { service_id: service!.id, quantity: 1 });
    postTask(db, task!.id);
  });

  after(() => {
    db.close();
    removeDbFiles(dbPath);
  });

  it('builds a commission job in the background and stores the live report shape', async () => {
    const telegramCalls: any[] = [];
    const worker = createReportWorker(db, {
      sendTelegram: async (telegramId?: any, text?: any) => {
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
    assert.equal(job!.status, 'pending');

    const finished = await worker.enqueue(job!.id);
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
    const finished = await worker.enqueue(job!.id);
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
    assert.equal(second!.job!.id, first!.job!.id);
  });

  it('stores finance location and currency params', () => {
    const actor = { type: 'user', userId: manager.id };
    const { job, created } = createOrReuseReportJob(db, {
      type: 'finance',
      input: {
        from_date: period.fromUnix,
        to_date: period.toUnix,
        location_id: 12,
        currency: 'USD',
      },
      actor,
    });
    assert.equal(created, true);
    assert.equal(job!.params.location_id, 12);
    assert.equal(job!.params.currency, 'USD');
    const presented = presentReportJob(job);
    assert.equal(presented!.params.location_id, 12);
    assert.equal(presented!.params.currency, 'USD');
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
    const previousBase = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'https://example.test';
    try {
      const telegramId = 777001;
      linkEmployeeTelegram(db, manager.id, telegramId, { firstName: 'Менеджер' });
      const sent: any[] = [];
      const worker = createReportWorker(db, {
        sendTelegram: async (id?: any, text?: any) => {
          sent.push({ id, text });
          return { sent: true };
        },
      });

      const passwordJob = createOrReuseReportJob(db, {
        type: 'commission',
        input: { from_date: period.fromUnix + 1, to_date: period.toUnix },
        actor: { type: 'password' },
      }).job;
      await worker.enqueue(passwordJob!.id);
      assert.equal(sent.length, 0);

      const telegramJob = createOrReuseReportJob(db, {
        type: 'commission',
        input: { from_date: period.fromUnix + 2, to_date: period.toUnix },
        actor: { type: 'telegram', telegramId },
      }).job;
      const finished = await worker.enqueue(telegramJob!.id);
      assert.equal(finished.status, 'ready');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].id, telegramId);
      assert.match(sent[0].text, /Баллы техника|Комиссия менеджера/);
      assert.match(sent[0].text, /готов/);
      assert.match(sent[0].text, /https:\/\/example\.test\/bot-admin\/reports\/\d+/);
    } finally {
      if (previousBase === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = previousBase;
    }
  });

  it('does not delete old report jobs when creating or resuming', () => {
    const worker = createReportWorker(db, {
      schedule: () => {},
      sendTelegram: async () => ({ sent: false, reason: 'no_telegram_id' }),
    });
    const actor = { type: 'password' };
    const { job } = createOrReuseReportJob(db, {
      type: 'finance',
      input: { from_date: period.fromUnix + 400, to_date: period.toUnix },
      actor,
    });
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 48 * 3600;
    db.prepare('UPDATE report_jobs SET created_at = ? WHERE id = ?').run(twoDaysAgo, job!.id);

    createOrReuseReportJob(db, {
      type: 'commission',
      input: { from_date: period.fromUnix + 401, to_date: period.toUnix },
      actor,
    });
    worker.resume();

    const kept = getReportJob(db, job!.id);
    assert.ok(kept);
    assert.equal(kept.id, job!.id);
  });

  it('lists jobs for an actor newest first without loading results', () => {
    const alice = { type: 'user', userId: manager.id };
    const bob = { type: 'user', userId: technician.id };
    const older = createOrReuseReportJob(db, {
      type: 'finance',
      input: { from_date: period.fromUnix + 500, to_date: period.toUnix },
      actor: alice,
    }).job;
    const newer = createOrReuseReportJob(db, {
      type: 'commission',
      input: { from_date: period.fromUnix + 501, to_date: period.toUnix },
      actor: alice,
    }).job;
    createOrReuseReportJob(db, {
      type: 'finance',
      input: { from_date: period.fromUnix + 502, to_date: period.toUnix },
      actor: bob,
    });

    const listed = listReportJobsForActor(db, alice, { offset: 0, limit: 25 });
    assert.ok(listed.total >= 2);
    const ids = listed.jobs.map((job?: any) => job.id);
    assert.ok(ids.includes(older!.id));
    assert.ok(ids.includes(newer!.id));
    assert.ok(ids.indexOf(newer!.id) < ids.indexOf(older!.id));
    const presented = presentReportJob(listed.jobs[0], { includeResult: false });
    assert.equal(Object.hasOwn((presented as any), 'result'), false);
    assert.equal(presented!.params.viewer, undefined);

    const financeOnly = listReportJobsForActor(db, alice, { offset: 0, limit: 25, type: 'finance' });
    assert.ok(financeOnly.jobs.every((job?: any) => job.type === 'finance'));
    assert.ok(financeOnly.jobs.some((job?: any) => job.id === older!.id));
    assert.equal(financeOnly.jobs.some((job?: any) => job.id === newer!.id), false);
  });

  it('deletes a report job by id', () => {
    const actor = { type: 'password' };
    const { job } = createOrReuseReportJob(db, {
      type: 'finance',
      input: { from_date: period.fromUnix + 700, to_date: period.toUnix },
      actor,
    });
    assert.equal(deleteReportJob(db, job!.id), true);
    assert.equal(getReportJob(db, job!.id), null);
    assert.equal(deleteReportJob(db, job!.id), false);
  });

  it('builds a stable /reports/:id admin URL', () => {
    const previous = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'https://example.test';
    try {
      assert.equal(buildReportPageUrl({ id: 42 }), 'https://example.test/bot-admin/reports/42');
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = previous;
    }
  });
});
