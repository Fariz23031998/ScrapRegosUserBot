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


describe('knowledge categories', () => {
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

  it('creates, updates, and lists categories', () => {
    const created = createKnowledgeCategory(db, { name: 'Прайс', tags: 'цены, услуги' });
    assert.equal(created!.name, 'Прайс');
    assert.equal(created!.tags, 'цены, услуги');

    const updated = updateKnowledgeCategory(db, created!.id, { name: 'Цены', tags: 'прайс' });
    assert.equal(updated!.name, 'Цены');
    assert.equal(updated!.tags, 'прайс');

    const listed = listKnowledgeCategories(db);
    assert.equal(listed.length, 1);
    assert.equal(listed![0]!.id, created!.id);
    assert.equal(listed![0]!.name, 'Цены');
  });

  it('formats a live category line for tools', () => {
    assert.equal(knowledgeCategoryContext(db), 'No categories yet. Omit category_id.');
    assert.equal(formatKnowledgeCategoriesForTools(db), knowledgeCategoryContext(db));
    const created = createKnowledgeCategory(db, { name: 'Прайс', tags: 'цены' });
    const line = knowledgeCategoryContext(db);
    assert.match(line, new RegExp(`${created!.id} Прайс`));
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
    assert.equal(created!.category_id, null);
    assert.equal(created!.category, null);
    assert.throws(
      () =>
        updateKnowledgeArticle(db, created!.id, {
          title: created!.title,
          body: created!.body,
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
      category_id: prices!.id,
    });
    const other = createKnowledgeArticle(db, {
      title: 'Support article',
      body: 'About support',
      tags: 'help',
      category_id: support!.id,
    });
    const loose = createKnowledgeArticle(db, {
      title: 'Loose article',
      body: 'No category',
      tags: '',
    });

    assert.equal(priced!.category_id, prices!.id);
    assert.equal(priced!.category?.name, 'Прайс');
    assert.equal(priced!.category?.tags, 'цены');

    const inPrices = listKnowledgeArticles(db, { categoryId: prices!.id, limit: 50 });
    assert.equal(inPrices.total, 1);
    assert.equal(inPrices.articles[0].id, priced!.id);

    const uncategorized = listKnowledgeArticles(db, { categoryId: null, limit: 50 });
    assert.ok(uncategorized.articles.some((article?: any) => article.id === loose!.id));
    assert.equal(
      uncategorized.articles.some((article?: any) => article.id === priced!.id),
      false
    );

    assert.equal(deleteKnowledgeCategory(db, prices!.id), true);
    const afterDelete = getKnowledgeArticle(db, priced!.id);
    assert.equal(afterDelete!.category_id, null);
    assert.equal(afterDelete!.category, null);
    assert.equal(getKnowledgeArticle(db, other!.id)!.category_id, support!.id);
  });
});

describe('knowledge category API', () => {
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
    assert.equal(after!.category_id, null);
  });
});

describe('knowledge article search retrieval', () => {
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

  function assertFindsOffice(query?: any) {
    const found = listKnowledgeArticles(db, { query, limit: 10 });
    assert.ok(
      found.articles.some((article?: any) => /как нас найти/i.test(article.title)),
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
