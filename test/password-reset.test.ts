import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { openDb } from '../src/db/partners-db';
import { createEmployeeUser, linkEmployeeTelegram } from '../src/db/bot-users-db';
import { createBotAdminRouter } from '../src/admin/bot-admin';
import {
  PASSWORD_RESET_CONFIRM_ERROR,
  PASSWORD_RESET_REQUEST_MESSAGE,
  setPasswordResetSender,
} from '../src/admin/bot-admin-routes-password-reset';

type SentMessage = { telegramId: unknown; text: string };

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-password-reset-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
}

function removeDbFiles(dbPath: string) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // ignore missing files
    }
  }
}

function request(server: http.Server, method: string, urlPath: string, body?: unknown) {
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      reject(new Error('Server is not listening'));
      return;
    }
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: urlPath,
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': String(payload.length),
            }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function codeFrom(text: string) {
  const match = text.match(/Код: (\d{6})/);
  assert.ok(match, `expected a code in ${text}`);
  return match[1];
}

describe('Employee password reset', () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;
  let previousEnv: Record<string, string | undefined>;
  let sent: SentMessage[];

  before(() => {
    previousEnv = {
      BOT_ADMIN_LOGIN: process.env.BOT_ADMIN_LOGIN,
      BOT_ADMIN_PASSWORD: process.env.BOT_ADMIN_PASSWORD,
    };
    process.env.BOT_ADMIN_LOGIN = 'admin';
    process.env.BOT_ADMIN_PASSWORD = 'test-password';
  });

  after(() => {
    setPasswordResetSender();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (db) db.close();
    if (dbPath) removeDbFiles(dbPath);
  });

  beforeEach(() => {
    sent = [];
    setPasswordResetSender(async (telegramId, text) => {
      sent.push({ telegramId, text });
    });
    if (db) {
      db.close();
    }
    if (dbPath) removeDbFiles(dbPath);
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
  });

  function listen() {
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    return new Promise<http.Server>((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  function createEmployee({
    login,
    telegramId,
    password = 'old-secret',
    phone,
  }: {
    login: string;
    telegramId?: number;
    password?: string;
    phone?: string;
  }) {
    const employee = createEmployeeUser(db, {
      phone: phone || `+99890${String(telegramId || login.length).padStart(7, '0').slice(-7)}`,
      displayName: login,
      adminLogin: login,
      password,
    });
    if (telegramId == null) return employee;
    return linkEmployeeTelegram(db, employee.id, telegramId, {
      username: 'reset_tester',
      firstName: 'Reset',
      lastName: 'Tester',
    });
  }

  function passwordHash(userId: number) {
    const row = db.prepare('SELECT password_hash FROM bot_users WHERE id = ?').get(userId) as {
      password_hash: string | null;
    };
    return row.password_hash;
  }

  it('sends a code only for a linked employee and hides unknown or unlinked logins', async () => {
    const linked = createEmployee({ login: 'panel.user', telegramId: 424242 });
    createEmployee({ login: 'offline.user', phone: '+998901110000' });
    const server = await listen();
    try {
      const unknown = await request(server, 'POST', '/bot-admin/api/password-reset/request', {
        login: 'missing.user',
      });
      const unlinked = await request(server, 'POST', '/bot-admin/api/password-reset/request', {
        login: 'offline.user',
      });
      const known = await request(server, 'POST', '/bot-admin/api/password-reset/request', {
        login: 'panel.user',
      });

      assert.equal(unknown.statusCode, 200);
      assert.equal(unlinked.statusCode, 200);
      assert.equal(known.statusCode, 200);
      assert.equal(unknown.body, unlinked.body);
      assert.equal(unlinked.body, known.body);
      assert.equal(JSON.parse(known.body).message, PASSWORD_RESET_REQUEST_MESSAGE);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].telegramId, linked.telegram_id);
      assert.match(sent[0].text, /Логин: panel\.user/);
      assert.match(sent[0].text, /10 минут/);
      codeFrom(sent[0].text);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sends and accepts a code when the employee enters a phone number', async () => {
    const employee = createEmployee({
      login: 'phone.user',
      telegramId: 434343,
      phone: '+998901112244',
      password: 'old-secret',
    });
    const server = await listen();
    try {
      const byPhone = await request(server, 'POST', '/bot-admin/api/password-reset/request', {
        login: '+998 90 111-22-44',
      });
      assert.equal(byPhone.statusCode, 200);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].telegramId, employee.telegram_id);
      assert.match(sent[0].text, /Логин: phone\.user/);

      db.prepare('UPDATE password_reset_codes SET created_at = ?').run(
        new Date(Date.now() - 90_000).toISOString()
      );
      const byTail = await request(server, 'POST', '/bot-admin/api/password-reset/request', {
        login: '901112244',
      });
      assert.equal(byTail.statusCode, 200);
      assert.equal(byTail.body, byPhone.body);
      assert.equal(sent.length, 2);

      const confirm = await request(server, 'POST', '/bot-admin/api/password-reset/confirm', {
        login: '998901112244',
        code: codeFrom(sent[1].text),
        password: 'phone-secret',
      });
      assert.equal(confirm.statusCode, 200);

      const loginRes = await request(server, 'POST', '/bot-admin/api/login', {
        login: 'phone.user',
        password: 'phone-secret',
      });
      assert.equal(loginRes.statusCode, 200);

      db.prepare('UPDATE password_reset_codes SET created_at = ?').run(
        new Date(Date.now() - 90_000).toISOString()
      );
      const beforeShort = sent.length;
      const shortNumber = await request(server, 'POST', '/bot-admin/api/password-reset/request', {
        login: '112244',
      });
      assert.equal(shortNumber.statusCode, 200);
      assert.equal(shortNumber.body, byPhone.body);
      assert.equal(sent.length, beforeShort);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sets a password that was empty and records an audit row without the password', async () => {
    const employee = createEmployee({ login: 'setup.user', telegramId: 515151, password: 'temp' });
    db.prepare('UPDATE bot_users SET password_hash = NULL WHERE id = ?').run(employee.id);
    assert.equal(passwordHash(employee.id), null);
    const server = await listen();
    try {
      await request(server, 'POST', '/bot-admin/api/password-reset/request', { login: 'setup.user' });
      const code = codeFrom(sent[0].text);
      const confirm = await request(server, 'POST', '/bot-admin/api/password-reset/confirm', {
        login: 'setup.user',
        code,
        password: 'brand-new-secret',
      });
      assert.equal(confirm.statusCode, 200);
      assert.equal(JSON.parse(confirm.body).ok, true);
      assert.match(String(passwordHash(employee.id)), /^scrypt\$/);

      const loginRes = await request(server, 'POST', '/bot-admin/api/login', {
        login: 'setup.user',
        password: 'brand-new-secret',
      });
      assert.equal(loginRes.statusCode, 200);

      const audit = db
        .prepare(
          `SELECT action, summary, details_json, actor_type
           FROM admin_audit_logs
           WHERE entity_id = ?`
        )
        .get(String(employee.id)) as {
        action: string;
        summary: string;
        details_json: string;
        actor_type: string | null;
      };
      assert.equal(audit.action, 'update');
      assert.match(audit.summary, /Telegram/);
      assert.equal(audit.actor_type, null);
      assert.equal(audit.details_json.includes('brand-new-secret'), false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('replaces an existing password and rejects the previous one', async () => {
    const employee = createEmployee({ login: 'restore.user', telegramId: 616161, password: 'old-secret' });
    const server = await listen();
    try {
      await request(server, 'POST', '/bot-admin/api/password-reset/request', { login: 'restore.user' });
      const confirm = await request(server, 'POST', '/bot-admin/api/password-reset/confirm', {
        login: 'restore.user',
        code: codeFrom(sent[0].text),
        password: 'new-secret',
      });
      assert.equal(confirm.statusCode, 200);

      const oldLogin = await request(server, 'POST', '/bot-admin/api/login', {
        login: 'restore.user',
        password: 'old-secret',
      });
      const newLogin = await request(server, 'POST', '/bot-admin/api/login', {
        login: 'restore.user',
        password: 'new-secret',
      });
      assert.equal(oldLogin.statusCode, 401);
      assert.equal(newLogin.statusCode, 200);
      assert.notEqual(passwordHash(employee.id), employee.password_hash);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not change the hash for a wrong, expired, or locked code', async () => {
    const wrongUser = createEmployee({ login: 'wrong.user', telegramId: 717171, password: 'keep-me' });
    const expiredUser = createEmployee({
      login: 'expired.user',
      telegramId: 717172,
      password: 'keep-me',
      phone: '+998907171720',
    });
    const lockedUser = createEmployee({
      login: 'locked.user',
      telegramId: 717173,
      password: 'keep-me',
      phone: '+998907171730',
    });
    const server = await listen();
    try {
      await request(server, 'POST', '/bot-admin/api/password-reset/request', { login: 'wrong.user' });
      const wrongBefore = passwordHash(wrongUser.id);
      const wrong = await request(server, 'POST', '/bot-admin/api/password-reset/confirm', {
        login: 'wrong.user',
        code: codeFrom(sent[0].text) === '000000' ? '111111' : '000000',
        password: 'changed-secret',
      });
      assert.equal(wrong.statusCode, 400);
      assert.equal(JSON.parse(wrong.body).message, PASSWORD_RESET_CONFIRM_ERROR);
      assert.equal(passwordHash(wrongUser.id), wrongBefore);

      sent = [];
      await request(server, 'POST', '/bot-admin/api/password-reset/request', { login: 'expired.user' });
      const expiredCode = codeFrom(sent[0].text);
      const expiredBefore = passwordHash(expiredUser.id);
      db.prepare('UPDATE password_reset_codes SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
      const expired = await request(server, 'POST', '/bot-admin/api/password-reset/confirm', {
        login: 'expired.user',
        code: expiredCode,
        password: 'changed-secret',
      });
      assert.equal(expired.statusCode, 400);
      assert.equal(JSON.parse(expired.body).message, PASSWORD_RESET_CONFIRM_ERROR);
      assert.equal(passwordHash(expiredUser.id), expiredBefore);

      sent = [];
      await request(server, 'POST', '/bot-admin/api/password-reset/request', { login: 'locked.user' });
      const lockedCode = codeFrom(sent[0].text);
      const lockedBefore = passwordHash(lockedUser.id);
      const wrongCode = lockedCode === '000000' ? '111111' : '000000';
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const failed = await request(server, 'POST', '/bot-admin/api/password-reset/confirm', {
          login: 'locked.user',
          code: wrongCode,
          password: 'changed-secret',
        });
        assert.equal(failed.statusCode, 400);
      }
      const locked = await request(server, 'POST', '/bot-admin/api/password-reset/confirm', {
        login: 'locked.user',
        code: lockedCode,
        password: 'changed-secret',
      });
      assert.equal(locked.statusCode, 400);
      assert.equal(JSON.parse(locked.body).message, PASSWORD_RESET_CONFIRM_ERROR);
      assert.equal(passwordHash(lockedUser.id), lockedBefore);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not reset the env superuser login', async () => {
    const employee = createEmployee({ login: 'admin', telegramId: 818181, password: 'employee-secret' });
    const before = passwordHash(employee.id);
    const server = await listen();
    try {
      const requested = await request(server, 'POST', '/bot-admin/api/password-reset/request', {
        login: 'admin',
      });
      assert.equal(requested.statusCode, 200);
      assert.equal(JSON.parse(requested.body).message, PASSWORD_RESET_REQUEST_MESSAGE);
      assert.equal(sent.length, 0);

      const confirmed = await request(server, 'POST', '/bot-admin/api/password-reset/confirm', {
        login: 'admin',
        code: '123456',
        password: 'new-secret',
      });
      assert.equal(confirmed.statusCode, 400);
      assert.equal(JSON.parse(confirmed.body).message, PASSWORD_RESET_CONFIRM_ERROR);
      assert.equal(passwordHash(employee.id), before);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('limits how often a code can be sent', async () => {
    createEmployee({ login: 'limited.user', telegramId: 919191 });
    const server = await listen();
    try {
      const first = await request(server, 'POST', '/bot-admin/api/password-reset/request', {
        login: 'limited.user',
      });
      const second = await request(server, 'POST', '/bot-admin/api/password-reset/request', {
        login: 'limited.user',
      });
      assert.equal(first.body, second.body);
      assert.equal(sent.length, 1);

      for (let sentCount = 1; sentCount < 5; sentCount += 1) {
        db.prepare('UPDATE password_reset_codes SET created_at = ?').run(
          new Date(Date.now() - 90_000).toISOString()
        );
        await request(server, 'POST', '/bot-admin/api/password-reset/request', { login: 'limited.user' });
        assert.equal(sent.length, sentCount + 1);
      }

      db.prepare('UPDATE password_reset_codes SET created_at = ?').run(
        new Date(Date.now() - 90_000).toISOString()
      );
      const blocked = await request(server, 'POST', '/bot-admin/api/password-reset/request', {
        login: 'limited.user',
      });
      assert.equal(blocked.statusCode, 200);
      assert.equal(blocked.body, first.body);
      assert.equal(sent.length, 5);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
