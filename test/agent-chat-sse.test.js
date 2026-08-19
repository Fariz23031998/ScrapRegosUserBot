const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const { respondAgentChat, wantsAgentSse } = require('../src/http/agent-chat-sse');

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, { accept, body }) {
  return new Promise((resolve, reject) => {
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
    req.write(payload);
    req.end();
  });
}

function parseSseFrames(body) {
  return String(body || '')
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const line = frame.startsWith('data: ') ? frame.slice(6) : frame;
      return JSON.parse(line);
    });
}

describe('agent chat SSE helper', () => {
  it('detects the event-stream accept header', () => {
    assert.equal(wantsAgentSse({ headers: { accept: 'application/json' } }), false);
    assert.equal(wantsAgentSse({ headers: { accept: 'text/event-stream' } }), true);
    assert.equal(wantsAgentSse({ headers: { accept: 'text/event-stream, application/json' } }), true);
  });

  it('returns JSON when SSE is not requested', async () => {
    const app = express();
    app.use(express.json());
    app.post('/ops-chat', (req, res) =>
      respondAgentChat(req, res, async ({ onDelta }) => {
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
    app.post('/ops-chat', (req, res) =>
      respondAgentChat(req, res, async ({ onDelta }) => {
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
    app.post('/ops-chat', (req, res) =>
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
});
