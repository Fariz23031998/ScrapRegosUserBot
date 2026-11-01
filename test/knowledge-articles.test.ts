import type { Unchecked } from '../src/types/unchecked';
import type { Response } from 'express';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { openDb } from '../src/db/partners-db';
import { createBotAdminRouter } from '../src/admin/bot-admin';
import { createEmployeeUser, DEFAULT_RIGHTS } from '../src/db/bot-users-db';
import { ADMIN_PERMISSION_KEYS, RIGHTS } from '../src/db/user-rights';
import { addKbSessionMessage, clearKbSessionHistory, createKnowledgeArticle, createKnowledgeCategory, deleteKnowledgeArticle, deleteKnowledgeCategory, getKnowledgeArticle, getOrCreateKbSession, listKbSessionMessages, listKnowledgeArticles, listKnowledgeCategories, formatKnowledgeCategoriesForTools, knowledgeCategoryContext, setKnowledgeArticleLocked, setKnowledgeArticleConfirmed, updateKnowledgeArticle, updateKnowledgeCategory } from '../src/db/knowledge-articles';
import { addKnowledgeImage } from '../src/db/knowledge-images';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-knowledge-lock-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

function cookieFromSetCookie(headerValue?: any) {
  const raw = headerValue;
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/,(?=\s*[^;=]+=)/);
  const match = list
    .map((part?: any) => String(part).trim())
    .find((part?: any) => part.startsWith('bot_admin_session='));
  return match ? match.split(';')[0] : null;
}


describe('knowledge article lock', () => {
  let dbPath: any;
  let db: any;

  beforeEach(() => {
    if (db) {
      db.close();
      db = null;
    }
    if (dbPath) removeDbFiles(dbPath);
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
  });

  after(() => {
    if (db) {
      db.close();
      db = null;
    }
    if (dbPath) removeDbFiles(dbPath);
  });

  it('exposes lock and unlock permissions', () => {
    assert.ok(RIGHTS.knowledge_lock);
    assert.ok(RIGHTS.knowledge_unlock);
    assert.equal(DEFAULT_RIGHTS.knowledge_lock, 0);
    assert.equal(DEFAULT_RIGHTS.knowledge_unlock, 0);
    assert.ok(ADMIN_PERMISSION_KEYS.includes('knowledge_lock'));
    assert.ok(ADMIN_PERMISSION_KEYS.includes('knowledge_unlock'));
    const cols = db.prepare('PRAGMA table_info(user_rights)').all();
    assert.ok(cols.some((col?: any) => col.name === 'knowledge_lock'));
    assert.ok(cols.some((col?: any) => col.name === 'knowledge_unlock'));
  });

  it('exposes confirm permission', () => {
    assert.ok(RIGHTS.knowledge_confirm);
    assert.equal(DEFAULT_RIGHTS.knowledge_confirm, 0);
    assert.ok(ADMIN_PERMISSION_KEYS.includes('knowledge_confirm'));
    const cols = db.prepare('PRAGMA table_info(user_rights)').all();
    assert.ok(cols.some((col?: any) => col.name === 'knowledge_confirm'));
  });

  it('creates articles unconfirmed and ignores is_confirmed on write', () => {
    const articleCols = db.prepare('PRAGMA table_info(knowledge_articles)').all();
    assert.ok(articleCols.some((col?: any) => col.name === 'is_confirmed'));
    assert.ok(articleCols.some((col?: any) => col.name === 'creator'));

    const seeded = listKnowledgeArticles(db);
    assert.ok(seeded.articles.length > 0);
    assert.ok(seeded.articles.every((article?: any) => article.is_confirmed === true));

    const created = createKnowledgeArticle(
      db,
      {
        title: 'Draft article',
        body: 'Needs review',
        tags: 'draft',
        is_confirmed: true,
        creator: 'hacked',
      },
      { creator: '42', updatedBy: 42 }
    );
    assert.equal(created!.is_confirmed, false);
    assert.equal(created!.creator, '42');

    const updated = updateKnowledgeArticle(db, created!.id, {
      title: 'Draft article',
      body: 'Needs review still',
      tags: 'draft',
      is_confirmed: true,
    });
    assert.equal(updated!.is_confirmed, false);
    assert.equal(updated!.creator, '42');

    const confirmed = setKnowledgeArticleConfirmed(db, created!.id, true);
    assert.equal(confirmed!.is_confirmed, true);
    const listedConfirmed = listKnowledgeArticles(db, { confirmedOnly: true, query: 'Needs review still' });
    assert.ok(listedConfirmed.articles.some((article?: any) => article.id === created!.id));
    assert.ok(getKnowledgeArticle(db, created!.id, { confirmedOnly: true }));

    const unconfirmed = setKnowledgeArticleConfirmed(db, created!.id, false);
    assert.equal(unconfirmed!.is_confirmed, false);
    assert.equal(getKnowledgeArticle(db, created!.id, { confirmedOnly: true }), null);
    assert.equal(getKnowledgeArticle(db, created!.id)!.id, created!.id);
    const hidden = listKnowledgeArticles(db, { confirmedOnly: true, query: 'Needs review still' });
    assert.ok(!hidden.articles.some((article?: any) => article.id === created!.id));
  });

  it('blocks edit and delete while locked, then allows them after unlock', () => {
    const created = createKnowledgeArticle(db, {
      title: 'Lockable article',
      body: 'Original body',
      tags: 'lock',
    });
    assert.equal(created!.locked, false);

    const locked = setKnowledgeArticleLocked(db, created!.id, true);
    assert.equal(locked!.locked, true);

    assert.throws(
      () => updateKnowledgeArticle(db, created!.id, { title: 'Changed', body: 'Changed', tags: 'lock' }),
      { message: 'ARTICLE_LOCKED' }
    );
    assert.throws(() => deleteKnowledgeArticle(db, created!.id), { message: 'ARTICLE_LOCKED' });
    assert.equal(getKnowledgeArticle(db, created!.id)!.title, 'Lockable article');

    const unlocked = setKnowledgeArticleLocked(db, created!.id, false);
    assert.equal(unlocked!.locked, false);
    const updated = updateKnowledgeArticle(db, created!.id, {
      title: 'Changed',
      body: 'Changed',
      tags: 'lock',
    });
    assert.equal(updated!.title, 'Changed');
    assert.equal(deleteKnowledgeArticle(db, created!.id), true);
    assert.equal(getKnowledgeArticle(db, created!.id), null);
  });

  it('includes images on listed articles after upload', () => {
    const previousImagesDir = process.env.KNOWLEDGE_IMAGES_DIR;
    const imagesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapregos-kb-list-images-'));
    process.env.KNOWLEDGE_IMAGES_DIR = imagesDir;
    try {
      const article = createKnowledgeArticle(db, {
        title: 'Listed with image',
        body: 'Has a screenshot',
        tags: 'img,list',
      });
      const image = addKnowledgeImage(db, article!.id, { buffer: PNG_1X1, originalName: 'ui.png' });
      const listed = listKnowledgeArticles(db, { query: 'Listed with image', limit: 10 });
      const found = listed.articles.find((row?: any) => row.id === article!.id);
      assert.ok(found);
      assert.ok(Array.isArray(found.images));
      assert.equal(found.images.length, 1);
      assert.equal(found.images[0].id, image!.id);
      assert.equal(found.images[0].url, `/bot-admin/api/knowledge/articles/${article!.id}/images/${image!.id}`);

      const recent = listKnowledgeArticles(db, { limit: 50 });
      const recentFound = recent.articles.find((row?: any) => row.id === article!.id);
      assert.ok(recentFound);
      assert.equal(recentFound.images.length, 1);
    } finally {
      if (previousImagesDir == null) delete process.env.KNOWLEDGE_IMAGES_DIR;
      else process.env.KNOWLEDGE_IMAGES_DIR = previousImagesDir;
      fs.rmSync(imagesDir, { recursive: true, force: true });
    }
  });

  it('deletes knowledge chat messages and keeps the session', () => {
    const session = getOrCreateKbSession(db, { userId: 42 });
    addKbSessionMessage(db, session!.id, { role: 'user', content: 'Hello' });
    addKbSessionMessage(db, session!.id, { role: 'assistant', content: 'Hi' });
    assert.equal(listKbSessionMessages(db, session!.id).length, 2);

    const cleared = clearKbSessionHistory(db, { sessionId: session!.id, userId: 42 });
    assert.equal(cleared!.id, session!.id);
    assert.equal(listKbSessionMessages(db, session!.id).length, 0);

    const other = getOrCreateKbSession(db, { userId: 99 });
    addKbSessionMessage(db, other!.id, { role: 'user', content: 'Secret' });
    assert.throws(() => clearKbSessionHistory(db, { sessionId: other!.id, userId: 42 }), {
      message: 'FORBIDDEN',
    });
    assert.equal(listKbSessionMessages(db, other!.id).length, 1);
  });
});

describe('knowledge article lock API', () => {
  let dbPath: any;
  let db: any;
  let server: any;
  let previousEnv: any;

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
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    server = await new Promise<any>((resolve?: any) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
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

  async function loginEmployee(rights?: any) {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-8);
    const login = `kb-${suffix}`;
    const password = 'kb-pass';
    const employee = createEmployeeUser(db, {
      phone: `+99890${suffix}`,
      displayName: 'Knowledge Tester',
      adminLogin: login,
      password,
      rights: { open_admin_dashboard: 1, knowledge_read: 1, ...rights },
    });
    const res = await request(server, 'POST', '/bot-admin/api/login', {
      body: { login, password },
    });
    assert.equal(res.statusCode, 200);
    const cookie = cookieFromSetCookie(res.headers['set-cookie']);
    assert.ok(cookie);
    return { cookie, employee };
  }

  it('requires lock/unlock rights and rejects edits while locked', async () => {
    const article = createKnowledgeArticle(db, {
      title: 'Protected article',
      body: 'Do not change',
      tags: 'protected',
    });
    const editor = await loginEmployee({ knowledge_edit: 1 });
    const locker = await loginEmployee({ knowledge_lock: 1 });
    const unlocker = await loginEmployee({ knowledge_unlock: 1 });

    const lockDenied = await request(server, 'POST', `/bot-admin/api/knowledge/articles/${article!.id}/lock`, {
      headers: { Cookie: editor.cookie },
    });
    assert.equal(lockDenied.statusCode, 403);

    const locked = await request(server, 'POST', `/bot-admin/api/knowledge/articles/${article!.id}/lock`, {
      headers: { Cookie: locker.cookie },
    });
    assert.equal(locked.statusCode, 200);
    assert.equal(JSON.parse(locked.body).article.locked, true);

    const updateDenied = await request(server, 'PUT', `/bot-admin/api/knowledge/articles/${article!.id}`, {
      headers: { Cookie: editor.cookie },
      body: { title: 'Hacked', body: 'Hacked', tags: 'protected' },
    });
    assert.equal(updateDenied.statusCode, 409);
    assert.match(JSON.parse(updateDenied.body).message, /заблокирована/i);

    const deleteDenied = await request(server, 'DELETE', `/bot-admin/api/knowledge/articles/${article!.id}`, {
      headers: { Cookie: editor.cookie },
    });
    assert.equal(deleteDenied.statusCode, 409);

    const unlockDenied = await request(server, 'POST', `/bot-admin/api/knowledge/articles/${article!.id}/unlock`, {
      headers: { Cookie: locker.cookie },
    });
    assert.equal(unlockDenied.statusCode, 403);

    const unlocked = await request(server, 'POST', `/bot-admin/api/knowledge/articles/${article!.id}/unlock`, {
      headers: { Cookie: unlocker.cookie },
    });
    assert.equal(unlocked.statusCode, 200);
    assert.equal(JSON.parse(unlocked.body).article.locked, false);

    const updated = await request(server, 'PUT', `/bot-admin/api/knowledge/articles/${article!.id}`, {
      headers: { Cookie: editor.cookie },
      body: { title: 'Updated', body: 'Updated', tags: 'protected' },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(JSON.parse(updated.body).article.title, 'Updated');
  });

  it('requires confirm right and keeps new articles unconfirmed', async () => {
    const editor = await loginEmployee({ knowledge_edit: 1 });
    const confirmer = await loginEmployee({ knowledge_confirm: 1 });

    const created = await request(server, 'POST', '/bot-admin/api/knowledge/articles', {
      headers: { Cookie: editor.cookie },
      body: {
        title: 'API draft',
        body: 'Wait for confirm',
        tags: 'draft',
        is_confirmed: true,
        creator: 'hacked',
      },
    });
    assert.equal(created.statusCode, 201);
    const article = JSON.parse(created.body).article;
    assert.equal(article.is_confirmed, false);
    assert.equal(article.creator, String(editor.employee.id));

    const confirmDenied = await request(server, 'POST', `/bot-admin/api/knowledge/articles/${article.id}/confirm`, {
      headers: { Cookie: editor.cookie },
    });
    assert.equal(confirmDenied.statusCode, 403);
    assert.equal(getKnowledgeArticle(db, article.id)!.is_confirmed, false);

    const confirmed = await request(server, 'POST', `/bot-admin/api/knowledge/articles/${article.id}/confirm`, {
      headers: { Cookie: confirmer.cookie },
    });
    assert.equal(confirmed.statusCode, 200);
    assert.equal(JSON.parse(confirmed.body).article.is_confirmed, true);

    const unconfirmed = await request(server, 'POST', `/bot-admin/api/knowledge/articles/${article.id}/unconfirm`, {
      headers: { Cookie: confirmer.cookie },
    });
    assert.equal(unconfirmed.statusCode, 200);
    assert.equal(JSON.parse(unconfirmed.body).article.is_confirmed, false);
  });

  it('clears knowledge chat history for editors', async () => {
    const editor = await loginEmployee({ knowledge_edit: 1 });
    const reader = await loginEmployee({});
    const session = getOrCreateKbSession(db, { userId: editor.employee.id });
    addKbSessionMessage(db, session!.id, { role: 'user', content: 'What is the price?' });
    addKbSessionMessage(db, session!.id, { role: 'assistant', content: 'See the catalog.' });

    const denied = await request(server, 'POST', '/bot-admin/api/ai/kb-session', {
      headers: { Cookie: reader.cookie },
      body: { session_id: session!.id, reset: true },
    });
    assert.equal(denied.statusCode, 403);

    const cleared = await request(server, 'POST', '/bot-admin/api/ai/kb-session', {
      headers: { Cookie: editor.cookie },
      body: { session_id: session!.id, reset: true },
    });
    assert.equal(cleared.statusCode, 200);
    const body = JSON.parse(cleared.body);
    assert.equal(body.session_id, session!.id);
    assert.deepEqual(body.messages, []);
    assert.equal(listKbSessionMessages(db, session!.id).length, 0);
  });

  it('paginates knowledge articles for the admin list', async () => {
    for (let i = 0; i < 5; i += 1) {
      createKnowledgeArticle(db, {
        title: `Paged article ${i}`,
        body: `Body for article ${i}`,
        tags: 'paged',
      });
    }
    const reader = await loginEmployee({});
    const page1 = await request(server, 'GET', '/bot-admin/api/knowledge/articles?page=1&limit=10', {
      headers: { Cookie: reader.cookie },
    });
    assert.equal(page1.statusCode, 200);
    const first = JSON.parse(page1.body);
    assert.equal(first.page, 1);
    assert.equal(first.limit, 10);
    assert.ok(first.total >= 5);
    assert.ok(first.articles.length <= 10);
    assert.equal(first.articles.length, Math.min(10, first.total));

    const dbPage = listKnowledgeArticles(db, { limit: 2, offset: 2 });
    assert.equal(dbPage.articles.length, 2);
    assert.ok(dbPage.total >= 5);

    const searched = await request(
      server,
      'GET',
      '/bot-admin/api/knowledge/articles?page=1&limit=10&q=Paged%20article%201',
      { headers: { Cookie: reader.cookie } }
    );
    assert.equal(searched.statusCode, 200);
    const searchBody = JSON.parse(searched.body);
    assert.ok(searchBody.articles.some((article?: any) => article.title === 'Paged article 1'));
    assert.ok(searchBody.total >= 1);
  });
});
