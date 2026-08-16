const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { openDb } = require('../src/db/partners-db');
const { createBotAdminRouter } = require('../src/admin/bot-admin');
const { createEmployeeUser, DEFAULT_RIGHTS } = require('../src/db/bot-users-db');
const { ADMIN_PERMISSION_KEYS, RIGHTS } = require('../src/db/user-rights');
const {
  addKbSessionMessage,
  clearKbSessionHistory,
  createKnowledgeArticle,
  createKnowledgeCategory,
  deleteKnowledgeArticle,
  deleteKnowledgeCategory,
  getKnowledgeArticle,
  getOrCreateKbSession,
  listKbSessionMessages,
  listKnowledgeArticles,
  listKnowledgeCategories,
  formatKnowledgeCategoriesForTools,
  knowledgeCategoryContext,
  setKnowledgeArticleLocked,
  updateKnowledgeArticle,
  updateKnowledgeCategory,
} = require('../src/db/knowledge-articles');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-knowledge-lock-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

function cookieFromSetCookie(headerValue) {
  const raw = headerValue;
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/,(?=\s*[^;=]+=)/);
  const match = list
    .map((part) => String(part).trim())
    .find((part) => part.startsWith('bot_admin_session='));
  return match ? match.split(';')[0] : null;
}

describe('knowledge article lock', () => {
  let dbPath;
  let db;

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
    assert.ok(cols.some((col) => col.name === 'knowledge_lock'));
    assert.ok(cols.some((col) => col.name === 'knowledge_unlock'));
  });

  it('blocks edit and delete while locked, then allows them after unlock', () => {
    const created = createKnowledgeArticle(db, {
      title: 'Lockable article',
      body: 'Original body',
      tags: 'lock',
    });
    assert.equal(created.locked, false);

    const locked = setKnowledgeArticleLocked(db, created.id, true);
    assert.equal(locked.locked, true);

    assert.throws(
      () => updateKnowledgeArticle(db, created.id, { title: 'Changed', body: 'Changed', tags: 'lock' }),
      { message: 'ARTICLE_LOCKED' }
    );
    assert.throws(() => deleteKnowledgeArticle(db, created.id), { message: 'ARTICLE_LOCKED' });
    assert.equal(getKnowledgeArticle(db, created.id).title, 'Lockable article');

    const unlocked = setKnowledgeArticleLocked(db, created.id, false);
    assert.equal(unlocked.locked, false);
    const updated = updateKnowledgeArticle(db, created.id, {
      title: 'Changed',
      body: 'Changed',
      tags: 'lock',
    });
    assert.equal(updated.title, 'Changed');
    assert.equal(deleteKnowledgeArticle(db, created.id), true);
    assert.equal(getKnowledgeArticle(db, created.id), null);
  });

  it('deletes knowledge chat messages and keeps the session', () => {
    const session = getOrCreateKbSession(db, { userId: 42 });
    addKbSessionMessage(db, session.id, { role: 'user', content: 'Hello' });
    addKbSessionMessage(db, session.id, { role: 'assistant', content: 'Hi' });
    assert.equal(listKbSessionMessages(db, session.id).length, 2);

    const cleared = clearKbSessionHistory(db, { sessionId: session.id, userId: 42 });
    assert.equal(cleared.id, session.id);
    assert.equal(listKbSessionMessages(db, session.id).length, 0);

    const other = getOrCreateKbSession(db, { userId: 99 });
    addKbSessionMessage(db, other.id, { role: 'user', content: 'Secret' });
    assert.throws(() => clearKbSessionHistory(db, { sessionId: other.id, userId: 42 }), {
      message: 'FORBIDDEN',
    });
    assert.equal(listKbSessionMessages(db, other.id).length, 1);
  });
});

describe('knowledge article lock API', () => {
  let dbPath;
  let db;
  let server;
  let previousEnv;

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
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
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

  async function loginEmployee(rights) {
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

    const lockDenied = await request(server, 'POST', `/bot-admin/api/knowledge/articles/${article.id}/lock`, {
      headers: { Cookie: editor.cookie },
    });
    assert.equal(lockDenied.statusCode, 403);

    const locked = await request(server, 'POST', `/bot-admin/api/knowledge/articles/${article.id}/lock`, {
      headers: { Cookie: locker.cookie },
    });
    assert.equal(locked.statusCode, 200);
    assert.equal(JSON.parse(locked.body).article.locked, true);

    const updateDenied = await request(server, 'PUT', `/bot-admin/api/knowledge/articles/${article.id}`, {
      headers: { Cookie: editor.cookie },
      body: { title: 'Hacked', body: 'Hacked', tags: 'protected' },
    });
    assert.equal(updateDenied.statusCode, 409);
    assert.match(JSON.parse(updateDenied.body).message, /заблокирована/i);

    const deleteDenied = await request(server, 'DELETE', `/bot-admin/api/knowledge/articles/${article.id}`, {
      headers: { Cookie: editor.cookie },
    });
    assert.equal(deleteDenied.statusCode, 409);

    const unlockDenied = await request(server, 'POST', `/bot-admin/api/knowledge/articles/${article.id}/unlock`, {
      headers: { Cookie: locker.cookie },
    });
    assert.equal(unlockDenied.statusCode, 403);

    const unlocked = await request(server, 'POST', `/bot-admin/api/knowledge/articles/${article.id}/unlock`, {
      headers: { Cookie: unlocker.cookie },
    });
    assert.equal(unlocked.statusCode, 200);
    assert.equal(JSON.parse(unlocked.body).article.locked, false);

    const updated = await request(server, 'PUT', `/bot-admin/api/knowledge/articles/${article.id}`, {
      headers: { Cookie: editor.cookie },
      body: { title: 'Updated', body: 'Updated', tags: 'protected' },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(JSON.parse(updated.body).article.title, 'Updated');
  });

  it('clears knowledge chat history for editors', async () => {
    const editor = await loginEmployee({ knowledge_edit: 1 });
    const reader = await loginEmployee({});
    const session = getOrCreateKbSession(db, { userId: editor.employee.id });
    addKbSessionMessage(db, session.id, { role: 'user', content: 'What is the price?' });
    addKbSessionMessage(db, session.id, { role: 'assistant', content: 'See the catalog.' });

    const denied = await request(server, 'POST', '/bot-admin/api/ai/kb-session', {
      headers: { Cookie: reader.cookie },
      body: { session_id: session.id, reset: true },
    });
    assert.equal(denied.statusCode, 403);

    const cleared = await request(server, 'POST', '/bot-admin/api/ai/kb-session', {
      headers: { Cookie: editor.cookie },
      body: { session_id: session.id, reset: true },
    });
    assert.equal(cleared.statusCode, 200);
    const body = JSON.parse(cleared.body);
    assert.equal(body.session_id, session.id);
    assert.deepEqual(body.messages, []);
    assert.equal(listKbSessionMessages(db, session.id).length, 0);
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
    assert.ok(searchBody.articles.some((article) => article.title === 'Paged article 1'));
    assert.ok(searchBody.total >= 1);
  });
});

describe('knowledge categories', () => {
  let dbPath;
  let db;

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

  it('creates, updates, and lists categories', () => {
    const created = createKnowledgeCategory(db, { name: 'Прайс', tags: 'цены, услуги' });
    assert.equal(created.name, 'Прайс');
    assert.equal(created.tags, 'цены, услуги');

    const updated = updateKnowledgeCategory(db, created.id, { name: 'Цены', tags: 'прайс' });
    assert.equal(updated.name, 'Цены');
    assert.equal(updated.tags, 'прайс');

    const listed = listKnowledgeCategories(db);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.id);
    assert.equal(listed[0].name, 'Цены');
  });

  it('formats a live category line for tools and agent context', () => {
    assert.equal(knowledgeCategoryContext(db), 'No categories yet. Omit category_id.');
    assert.equal(formatKnowledgeCategoriesForTools(db), knowledgeCategoryContext(db));
    const created = createKnowledgeCategory(db, { name: 'Прайс', tags: 'цены' });
    const line = knowledgeCategoryContext(db);
    assert.match(line, new RegExp(`${created.id} Прайс`));
    assert.match(line, /Omit or null for none/);
    assert.equal(formatKnowledgeCategoriesForTools(db), line);
  });

  it('rejects invalid category names and unknown article categories', () => {
    assert.throws(() => createKnowledgeCategory(db, { name: '  ' }), { message: 'INVALID_CATEGORY_NAME' });
    const created = createKnowledgeArticle(db, {
      title: 'Uncategorized',
      body: 'No category yet',
      tags: '',
    });
    assert.equal(created.category_id, null);
    assert.equal(created.category, null);
    assert.throws(
      () =>
        updateKnowledgeArticle(db, created.id, {
          title: created.title,
          body: created.body,
          category_id: 999,
        }),
      { message: 'INVALID_ARTICLE_CATEGORY' }
    );
  });

  it('assigns a category, filters the list, and unsets it when the category is deleted', () => {
    const prices = createKnowledgeCategory(db, { name: 'Прайс', tags: 'цены' });
    const support = createKnowledgeCategory(db, { name: 'Поддержка', tags: 'support' });
    const priced = createKnowledgeArticle(db, {
      title: 'Price article',
      body: 'About prices',
      tags: 'price',
      category_id: prices.id,
    });
    const other = createKnowledgeArticle(db, {
      title: 'Support article',
      body: 'About support',
      tags: 'help',
      category_id: support.id,
    });
    const loose = createKnowledgeArticle(db, {
      title: 'Loose article',
      body: 'No category',
      tags: '',
    });

    assert.equal(priced.category_id, prices.id);
    assert.equal(priced.category?.name, 'Прайс');
    assert.equal(priced.category?.tags, 'цены');

    const inPrices = listKnowledgeArticles(db, { categoryId: prices.id, limit: 50 });
    assert.equal(inPrices.total, 1);
    assert.equal(inPrices.articles[0].id, priced.id);

    const uncategorized = listKnowledgeArticles(db, { categoryId: null, limit: 50 });
    assert.ok(uncategorized.articles.some((article) => article.id === loose.id));
    assert.equal(
      uncategorized.articles.some((article) => article.id === priced.id),
      false
    );

    assert.equal(deleteKnowledgeCategory(db, prices.id), true);
    const afterDelete = getKnowledgeArticle(db, priced.id);
    assert.equal(afterDelete.category_id, null);
    assert.equal(afterDelete.category, null);
    assert.equal(getKnowledgeArticle(db, other.id).category_id, support.id);
  });
});

describe('knowledge category API', () => {
  let dbPath;
  let db;
  let server;
  let previousEnv;

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
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
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

  async function loginEmployee(rights) {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-8);
    const login = `kb-${suffix}`;
    const password = 'kb-pass';
    createEmployeeUser(db, {
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
    return { cookie };
  }

  it('creates a category, assigns it to an article, filters, and rejects unknown ids', async () => {
    const editor = await loginEmployee({ knowledge_edit: 1 });

    const createdCategory = await request(server, 'POST', '/bot-admin/api/knowledge/categories', {
      headers: { Cookie: editor.cookie },
      body: { name: 'Офис', tags: 'адрес, контакты' },
    });
    assert.equal(createdCategory.statusCode, 201);
    const category = JSON.parse(createdCategory.body).category;
    assert.equal(category.name, 'Офис');

    const createdArticle = await request(server, 'POST', '/bot-admin/api/knowledge/articles', {
      headers: { Cookie: editor.cookie },
      body: {
        title: 'Office hours',
        body: 'We are open 9-18.',
        tags: 'office',
        category_id: category.id,
      },
    });
    assert.equal(createdArticle.statusCode, 201);
    const article = JSON.parse(createdArticle.body).article;
    assert.equal(article.category_id, category.id);
    assert.equal(article.category.name, 'Офис');

    const filtered = await request(
      server,
      'GET',
      `/bot-admin/api/knowledge/articles?page=1&limit=20&category_id=${category.id}`,
      { headers: { Cookie: editor.cookie } }
    );
    assert.equal(filtered.statusCode, 200);
    const filteredBody = JSON.parse(filtered.body);
    assert.equal(filteredBody.total, 1);
    assert.equal(filteredBody.articles[0].id, article.id);

    const unknown = await request(server, 'POST', '/bot-admin/api/knowledge/articles', {
      headers: { Cookie: editor.cookie },
      body: { title: 'Bad', body: 'Bad', tags: '', category_id: 9999 },
    });
    assert.equal(unknown.statusCode, 400);
    assert.match(JSON.parse(unknown.body).message, /категор/i);

    const deleted = await request(server, 'DELETE', `/bot-admin/api/knowledge/categories/${category.id}`, {
      headers: { Cookie: editor.cookie },
    });
    assert.equal(deleted.statusCode, 200);
    const after = getKnowledgeArticle(db, article.id);
    assert.equal(after.category_id, null);
  });
});

describe('knowledge article search retrieval', () => {
  let dbPath;
  let db;

  beforeEach(() => {
    if (db) {
      db.close();
      db = null;
    }
    if (dbPath) removeDbFiles(dbPath);
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    createKnowledgeArticle(db, {
      title: 'Как нас найти — офисы, телефон, Telegram и Instagram',
      body:
        'Ташкент — Rofeev Technology. Адрес: Чиланзарский район. Самарканд — ул. Гагарина. Телефон офиса +998 55 701 00 08.',
      tags: 'офис, адрес, контакты, telegram, ташкент, самарканд',
    });
  });

  after(() => {
    if (db) db.close();
    if (dbPath) removeDbFiles(dbPath);
  });

  function assertFindsOffice(query) {
    const found = listKnowledgeArticles(db, { query, limit: 10 });
    assert.ok(
      found.articles.some((article) => /как нас найти/i.test(article.title)),
      `expected office article for query: ${query}`
    );
  }

  it('finds office article by multi-token Russian query', () => {
    assertFindsOffice('офис адрес');
  });

  it('finds office article by uzbek/english synonyms', () => {
    assertFindsOffice('ofis manzil');
  });

  it('finds office article despite noisy mixed-language agent query', () => {
    assertFindsOffice('офис qayerda joylashgan manzil REGOS ROFEEV');
  });

  it('matches Cyrillic title case-insensitively', () => {
    assertFindsOffice('как нас найти');
  });

  it('returns empty for unrelated garbage', () => {
    const found = listKnowledgeArticles(db, { query: 'xyzzy-no-such-article-qqq', limit: 10 });
    assert.equal(found.total, 0);
    assert.deepEqual(found.articles, []);
  });

  it('ranks the office article first over a weak synonym decoy', () => {
    createKnowledgeArticle(db, {
      title: 'Лицензии REGOS',
      body: 'REGOS portal location and general company notes. No office address here.',
      tags: 'regos',
    });
    const found = listKnowledgeArticles(db, { query: 'офис адрес', limit: 10 });
    assert.ok(found.articles.length >= 2);
    assert.match(found.articles[0].title, /как нас найти/i);
  });

  it('ranks a title match above a body-only synonym match', () => {
    createKnowledgeArticle(db, {
      title: 'Прочее',
      body: 'The warehouse location is listed on the map only.',
      tags: '',
    });
    const found = listKnowledgeArticles(db, { query: 'офис', limit: 10 });
    assert.ok(found.articles.length >= 2);
    assert.match(found.articles[0].title, /как нас найти/i);
  });
});
