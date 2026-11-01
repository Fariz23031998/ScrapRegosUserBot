import type { Unchecked } from '../src/types/unchecked';
import type { Response } from 'express';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { openDb } from '../src/db/partners-db';
import { createKnowledgeArticle, deleteKnowledgeArticle, getKnowledgeArticle } from '../src/db/knowledge-articles';
import { addKnowledgeImage, appendKnowledgeImageMarkdown, decodeKnowledgeImageData, deleteKnowledgeImage, fetchRemoteImageBuffer, getKnowledgeImagesRoot, listKnowledgeImages, stripKnowledgeImageMarkdown } from '../src/db/knowledge-images';
import { createBotAdminRouter } from '../src/admin/bot-admin';
import { createEmployeeUser } from '../src/db/bot-users-db';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function makeTempDir(prefix?: any) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-knowledge-images-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('knowledge images', () => {
  let dbPath: any;
  let db: any;
  let imagesDir: any;
  let previousImagesDir: any;

  before(() => {
    previousImagesDir = process.env.KNOWLEDGE_IMAGES_DIR;
    imagesDir = makeTempDir('scrapregos-knowledge-images-');
    process.env.KNOWLEDGE_IMAGES_DIR = imagesDir;
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
  });

  after(() => {
    db.close();
    removeDbFiles(dbPath);
    if (previousImagesDir == null) delete process.env.KNOWLEDGE_IMAGES_DIR;
    else process.env.KNOWLEDGE_IMAGES_DIR = previousImagesDir;
    fs.rmSync(imagesDir, { recursive: true, force: true });
  });

  it('stores a screenshot, appends markdown, and cleans up on article delete', () => {
    const article = createKnowledgeArticle(db, {
      title: 'With screenshot',
      body: 'Step one',
      tags: 'img',
    });
    const image = addKnowledgeImage(db, article!.id, { buffer: PNG_1X1, originalName: 'ui.png' });
    assert.equal(image!.mime, 'image/png');
    assert.equal(image!.url, `/bot-admin/api/knowledge/articles/${article!.id}/images/${image!.id}`);
    const filePath = path.join(getKnowledgeImagesRoot(), String(article!.id), image!.filename);
    assert.equal(fs.existsSync(filePath), true);

    const withMarkdown = appendKnowledgeImageMarkdown(article!.body, image, 'ui.png');
    assert.match(withMarkdown, /!\[ui\.png\]\(/);
    assert.match(withMarkdown, new RegExp(image!.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const stripped = stripKnowledgeImageMarkdown(`${withMarkdown}\n\nkeep`, image);
    assert.match(stripped, /keep/);
    assert.doesNotMatch(stripped, /ui\.png/);

    deleteKnowledgeArticle(db, article!.id);
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(getKnowledgeArticle(db, article!.id), null);
  });

  it('rejects non-images and decodes base64', () => {
    const article = createKnowledgeArticle(db, {
      title: 'Invalid image',
      body: 'Body',
      tags: '',
    });
    assert.throws(
      () => addKnowledgeImage(db, article!.id, { buffer: Buffer.from('not-an-image') }),
      { message: 'INVALID_IMAGE_TYPE' }
    );
    const decoded = decodeKnowledgeImageData(PNG_1X1.toString('base64'));
    const image = addKnowledgeImage(db, article!.id, { buffer: decoded, originalName: 'from-b64.png' });
    assert.equal(listKnowledgeImages(db, article!.id).length, 1);
    deleteKnowledgeImage(db, article!.id, image!.id);
    assert.equal(listKnowledgeImages(db, article!.id).length, 0);
  });

  it('blocks private screenshot URLs', async () => {
    await assert.rejects(() => fetchRemoteImageBuffer('http://127.0.0.1/secret.png'), {
      message: 'INVALID_IMAGE_URL',
    });
    await assert.rejects(() => fetchRemoteImageBuffer('http://localhost/x.png'), {
      message: 'INVALID_IMAGE_URL',
    });
    await assert.rejects(() => fetchRemoteImageBuffer('file:///tmp/x.png'), {
      message: 'INVALID_IMAGE_URL',
    });
  });
});

describe('knowledge image HTTP upload', () => {
  let dbPath: any;
  let db: any;
  let server: any;
  let imagesDir: any;
  let previousEnv: any;

  function request(method: any, urlPath: any, { headers = {}, body = null }: Unchecked = {}) {
    return new Promise<any>((resolve?: any, reject?: any) => {
      const { port } = server.address();
      const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method,
          headers: {
            Accept: 'application/json',
            ...(body && !Buffer.isBuffer(body)
              ? { 'Content-Type': 'application/json', 'Content-Length': payload!.length }
              : payload
                ? { 'Content-Length': payload.length }
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
              body: Buffer.concat(chunks),
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
    const list = Array.isArray(headerValue) ? headerValue : String(headerValue || '').split(/,(?=\s*[^;=]+=)/);
    const match = list
      .map((part?: any) => String(part).trim())
      .find((part?: any) => part.startsWith('bot_admin_session='));
    return match ? match.split(';')[0] : null;
  }

  before(async () => {
    previousEnv = {
      BOT_ADMIN_LOGIN: process.env.BOT_ADMIN_LOGIN,
      BOT_ADMIN_PASSWORD: process.env.BOT_ADMIN_PASSWORD,
      KNOWLEDGE_IMAGES_DIR: process.env.KNOWLEDGE_IMAGES_DIR,
    };
    process.env.BOT_ADMIN_LOGIN = 'admin';
    process.env.BOT_ADMIN_PASSWORD = 'test-password';
    imagesDir = makeTempDir('scrapregos-knowledge-images-http-');
    process.env.KNOWLEDGE_IMAGES_DIR = imagesDir;
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    server = await new Promise<any>((resolve?: any) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
  });

  after(async () => {
    if (server) await new Promise<any>((resolve?: any) => server.close(resolve));
    if (db) db.close();
    if (dbPath) removeDbFiles(dbPath);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value as any;
    }
    fs.rmSync(imagesDir, { recursive: true, force: true });
  });

  it('uploads a screenshot and serves the file', async () => {
    const suffix = `${Date.now()}`.slice(-8);
    const login = `kb-img-${suffix}`;
    createEmployeeUser(db, {
      phone: `+99891${suffix}`,
      displayName: 'Image Tester',
      adminLogin: login,
      password: 'kb-pass',
      rights: { open_admin_dashboard: 1, knowledge_read: 1, knowledge_edit: 1 },
    });
    const loginRes = await request('POST', '/bot-admin/api/login', { body: { login, password: 'kb-pass' } });
    assert.equal(loginRes.statusCode, 200);
    const cookie = cookieFromSetCookie(loginRes.headers['set-cookie']);
    assert.ok(cookie);

    const article = createKnowledgeArticle(db, { title: 'HTTP screenshot', body: 'Before', tags: '' });
    const boundary = '----kbimgtest';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="shot.png"\r\nContent-Type: image/png\r\n\r\n`
      ),
      PNG_1X1,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploaded = await request('POST', `/bot-admin/api/knowledge/articles/${article!.id}/images`, {
      headers: {
        Cookie: cookie,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: payload,
    });
    assert.equal(uploaded.statusCode, 201);
    const data = JSON.parse(uploaded.body.toString('utf8'));
    assert.equal(data.article.images.length, 1);
    assert.match(data.article.body, /!\[shot\.png\]\(/);

    const image = data.article.images[0];
    const fileRes = await request('GET', image.url, { headers: { Cookie: cookie } });
    assert.equal(fileRes.statusCode, 200);
    assert.match(String(fileRes.headers['content-type']), /image\/png/);
    assert.equal(fileRes.body.equals(PNG_1X1), true);

    const deleted = await request('DELETE', image.url, { headers: { Cookie: cookie } });
    assert.equal(deleted.statusCode, 200);
    const after = JSON.parse(deleted.body.toString('utf8'));
    assert.equal(after.article.images.length, 0);
    assert.doesNotMatch(after.article.body, /shot\.png/);
  });
});
