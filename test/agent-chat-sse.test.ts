import type { Unchecked } from '../src/types/unchecked';
import type { Request, Response } from 'express';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import { respondAgentChat, wantsAgentSse } from '../src/http/agent-chat-sse';

function listen(app?: any) {
  return new Promise<any>((resolve?: any) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server: any, { accept, body }: Unchecked) {
  return new Promise<any>((resolve?: any, reject?: any) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: server.address().port,
        path: '/ops-chat',
        method: 'POST',
        headers: {
          Accept: accept,
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
            headers: res.headers,
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

function parseSseFrames(body?: any) {
  return String(body || '')
    .split('\n\n')
    .map((frame?: any) => frame.trim())
    .filter(Boolean)
    .map((frame?: any) => {
      const line = frame.startsWith('data: ') ? frame.slice(6) : frame;
      return JSON.parse(line);
    });
}

describe('agent chat SSE helper', () => {
  it('detects the event-stream accept header', () => {
    assert.equal(wantsAgentSse(({ headers: { accept: 'application/json' } } as any)), false);
    assert.equal(wantsAgentSse(({ headers: { accept: 'text/event-stream' } } as any)), true);
    assert.equal(wantsAgentSse(({ headers: { accept: 'text/event-stream, application/json' } } as any)), true);
  });

  it('returns JSON when SSE is not requested', async () => {
    const app = express();
    app.use(express.json());
    app.post('/ops-chat', (req: Request, res: Response) =>
      respondAgentChat(req, res, async ({ onDelta }: Unchecked) => {
        assert.equal(onDelta, undefined);
        return { session_id: 7, reply: 'Готово.', messages: [{ id: 1, role: 'assistant', content: 'Готово.' }] };
      })
    );
    const server = await listen(app);
    try {
      const res = await request(server, { accept: 'application/json', body: { message: 'hi' } });
      assert.equal(res.statusCode, 200);
      assert.match(String(res.headers['content-type'] || ''), /json/i);
      const payload = JSON.parse(res.body);
      assert.equal(payload.session_id, 7);
      assert.equal(payload.reply, 'Готово.');
    } finally {
      server.close();
    }
  });

  it('streams delta then done when Accept is text/event-stream', async () => {
    const app = express();
    app.use(express.json());
    app.post('/ops-chat', (req: Request, res: Response) =>
      respondAgentChat(req, res, async ({ onDelta }: Unchecked) => {
        await onDelta('При');
        await onDelta('вет');
        return { session_id: 3, reply: 'Привет', messages: [{ id: 2, role: 'assistant', content: 'Привет' }] };
      })
    );
    const server = await listen(app);
    try {
      const res = await request(server, { accept: 'text/event-stream', body: { message: 'hi' } });
      assert.equal(res.statusCode, 200);
      assert.match(String(res.headers['content-type'] || ''), /text\/event-stream/i);
      const events = parseSseFrames(res.body);
      assert.deepEqual(events[0], { type: 'delta', text: 'При' });
      assert.deepEqual(events[1], { type: 'delta', text: 'вет' });
      assert.equal(events[2].type, 'done');
      assert.equal(events[2].session_id, 3);
      assert.equal(events[2].reply, 'Привет');
    } finally {
      server.close();
    }
  });

  it('emits an error event when the agent run fails', async () => {
    const app = express();
    app.use(express.json());
    app.post('/ops-chat', (req: Request, res: Response) =>
      respondAgentChat(
        req,
        res,
        async () => {
          throw new Error('OPENAI_API_KEY is not configured');
        },
        { mapError: () => 'Не настроен ключ OpenAI.' }
      )
    );
    const server = await listen(app);
    try {
      const res = await request(server, { accept: 'text/event-stream', body: { message: 'hi' } });
      assert.equal(res.statusCode, 200);
      const events = parseSseFrames(res.body);
      assert.deepEqual(events, [{ type: 'error', message: 'Не настроен ключ OpenAI.' }]);
    } finally {
      server.close();
    }
  });

  it('logs the underlying error when the agent run fails', async () => {
    const errors: any[] = [];
    const original = console.error;
    console.error = (...args: any[]) => errors.push(args);
    const app = express();
    app.use(express.json());
    app.post('/ops-chat', (req: Request, res: Response) =>
      respondAgentChat(req, res, async () => {
        throw new Error('boom-from-ops');
      })
    );
    const server = await listen(app);
    try {
      const res = await request(server, { accept: 'text/event-stream', body: { message: 'hi' } });
      assert.equal(res.statusCode, 200);
      const events = parseSseFrames(res.body);
      assert.equal(events[0].type, 'error');
      assert.match(String(errors[0]?.[1]?.message || errors[0]?.[0]), /boom-from-ops/);
    } finally {
      console.error = original;
      server.close();
    }
  });
});
