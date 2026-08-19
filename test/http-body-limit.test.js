const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const { CHAT_MESSAGE_JSON_LIMIT } = require('../src/ai/chat-uploads');
const { createAppBodyParsers, payloadTooLargeHandler } = require('../src/http/body-parser');

function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('HTTP JSON body limits', () => {
  it('lets bot-admin chat routes accept payloads over the default 100kb json limit', async () => {
    const app = express();
    app.use(createAppBodyParsers());
    app.post(
      '/bot-admin/api/ai/ops-chat',
      express.json({ limit: CHAT_MESSAGE_JSON_LIMIT }),
      (req, res) => {
        res.json({ ok: true, size: String(req.body?.message || '').length });
      }
    );
    app.post('/click/prepare', (req, res) => {
      res.json({ ok: Boolean(req.body) });
    });
    app.use(payloadTooLargeHandler);

    const server = await listen(app);
    try {
      const oversized = { message: 'x'.repeat(200 * 1024) };
      const chat = await request(server, 'POST', '/bot-admin/api/ai/ops-chat', oversized);
      assert.equal(chat.statusCode, 200);
      assert.equal(JSON.parse(chat.body).size, 200 * 1024);

      const click = await request(server, 'POST', '/click/prepare', oversized);
      assert.equal(click.statusCode, 413);
      assert.match(JSON.parse(click.body).message, /большой/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects oversized bot-admin chat JSON with a JSON 413 after the chat limit', async () => {
    const app = express();
    app.use(createAppBodyParsers());
    app.post(
      '/bot-admin/api/ai/ops-chat',
      express.json({ limit: '1kb' }),
      (req, res) => {
        res.json({ ok: true, size: String(req.body?.message || '').length });
      }
    );
    app.use(payloadTooLargeHandler);

    const server = await listen(app);
    try {
      const res = await request(server, 'POST', '/bot-admin/api/ai/ops-chat', {
        message: 'x'.repeat(8 * 1024),
      });
      assert.equal(res.statusCode, 413);
      assert.match(JSON.parse(res.body).message, /большой/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
