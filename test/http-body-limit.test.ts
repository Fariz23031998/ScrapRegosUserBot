import type { Request, Response } from 'express';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import { CHAT_MESSAGE_JSON_LIMIT } from '../src/ai/chat-uploads';
import { createAppBodyParsers, payloadTooLargeHandler } from '../src/http/body-parser';

function request(server?: any, method?: any, urlPath?: any, body?: any) {
  return new Promise<any>((resolve?: any, reject?: any) => {
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
      (res: any) => {
        const chunks: any[] = [];
        res.on('data', (chunk?: any) => chunks.push(chunk));
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

function listen(app?: any) {
  const server = http.createServer(app);
  return new Promise<any>((resolve?: any) => {
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
      (req: Request, res: Response) => {
        res.json({ ok: true, size: String(req.body?.message || '').length });
      }
    );
    app.post('/click/prepare', (req: Request, res: Response) => {
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
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });

  it('rejects oversized bot-admin chat JSON with a JSON 413 after the chat limit', async () => {
    const app = express();
    app.use(createAppBodyParsers());
    app.post(
      '/bot-admin/api/ai/ops-chat',
      express.json({ limit: '1kb' }),
      (req: Request, res: Response) => {
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
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });
});
