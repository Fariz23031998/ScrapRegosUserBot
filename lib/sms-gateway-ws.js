const { WebSocketServer } = require('ws');
const { URL } = require('url');
const { logOrderEvent } = require('./order-logs');
const {
  SMS_NEW_CHANNEL,
  isRedisConfigured,
  createRedisClient,
} = require('./redis-client');
const {
  getSmsJob,
  updateSmsJob,
  removePendingJob,
  listPendingJobIds,
} = require('./sms-queue');

const WS_PATH = '/sms-gateway/ws';
const HEARTBEAT_MS = 45000;
const AUTH_TIMEOUT_MS = 10000;

function parseMessage(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sendJson(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function closeWithReason(ws, code, reason) {
  try {
    ws.close(code, reason);
  } catch {
    ws.terminate();
  }
}

function attachSmsGateway(httpServer, { db }) {
  if (!isRedisConfigured()) {
    console.warn('REDIS_URL not set — SMS WebSocket gateway disabled.');
    return null;
  }

  const gatewayToken = process.env.SMS_GATEWAY_TOKEN?.trim();
  if (!gatewayToken) {
    console.warn('SMS_GATEWAY_TOKEN not set — SMS WebSocket gateway disabled.');
    return null;
  }

  const subscriber = createRedisClient({ forSubscriber: true });
  subscriber.subscribe(SMS_NEW_CHANNEL).catch((err) => {
    console.error('[SMS gateway] Redis subscribe failed:', err.message);
  });

  let activeClient = null;

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  async function deliverNextJob(ws) {
    if (ws !== activeClient || ws.readyState !== ws.OPEN || ws._smsBusy) {
      return;
    }

    const pendingIds = await listPendingJobIds();
    for (const jobId of pendingIds) {
      const job = await getSmsJob(jobId);
      if (!job || job.status !== 'pending') {
        await removePendingJob(jobId);
        continue;
      }

      ws._smsBusy = true;
      ws._currentJobId = job.id;
      sendJson(ws, {
        type: 'sms',
        job: {
          id: job.id,
          phone: job.phone,
          message: job.message,
          orderId: job.orderId,
        },
      });
      return;
    }
  }

  async function handleResult(ws, msg) {
    if (ws !== activeClient || !ws._currentJobId) {
      return;
    }

    const jobId = String(msg.jobId || '');
    if (jobId !== ws._currentJobId) {
      sendJson(ws, { type: 'error', message: 'Unexpected job result' });
      return;
    }

    const job = await getSmsJob(jobId);
    if (!job) {
      ws._smsBusy = false;
      ws._currentJobId = null;
      return;
    }

    const success = Boolean(msg.success);
    const logBase = {
      orderId: job.orderId,
      actorTelegramId: job.actorTelegramId ?? null,
      actorPhone: job.actorPhone ?? null,
      orderAmount: job.orderAmount ?? null,
      clientPhone: job.clientPhone ?? null,
    };

    if (success) {
      await updateSmsJob(jobId, { status: 'sent', sentAt: new Date().toISOString() });
      logOrderEvent(db, { ...logBase, action: 'sms_sent' });
    } else {
      const error = String(msg.error || 'send_failed');
      await updateSmsJob(jobId, {
        status: 'failed',
        failedAt: new Date().toISOString(),
        error,
      });
      logOrderEvent(db, { ...logBase, action: 'sms_failed' });
      console.error('[SMS gateway] Device failed to send SMS:', error);
    }

    await removePendingJob(jobId);
    ws._smsBusy = false;
    ws._currentJobId = null;
    await deliverNextJob(ws);
  }

  function setupConnection(ws) {
    ws.isAlive = true;
    ws.authenticated = false;
    ws._smsBusy = false;
    ws._currentJobId = null;

    const authTimer = setTimeout(() => {
      if (!ws.authenticated) {
        closeWithReason(ws, 4401, 'auth_timeout');
      }
    }, AUTH_TIMEOUT_MS);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', async (raw) => {
      const msg = parseMessage(String(raw));
      if (!msg || !msg.type) {
        sendJson(ws, { type: 'error', message: 'Invalid message' });
        return;
      }

      if (!ws.authenticated) {
        if (msg.type !== 'auth') {
          closeWithReason(ws, 4401, 'auth_required');
          return;
        }

        const token = String(msg.token || '').trim();
        if (token !== gatewayToken) {
          sendJson(ws, { type: 'auth_failed' });
          closeWithReason(ws, 4403, 'invalid_token');
          return;
        }

        ws.authenticated = true;
        clearTimeout(authTimer);

        if (activeClient && activeClient !== ws && activeClient.readyState === activeClient.OPEN) {
          closeWithReason(activeClient, 4000, 'replaced');
        }
        activeClient = ws;

        sendJson(ws, { type: 'auth_ok' });
        await deliverNextJob(ws);
        return;
      }

      if (msg.type === 'ping') {
        sendJson(ws, { type: 'pong' });
        return;
      }

      if (msg.type === 'result') {
        await handleResult(ws, msg);
        return;
      }

      sendJson(ws, { type: 'error', message: 'Unknown message type' });
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (activeClient === ws) {
        activeClient = null;
      }
    });

    ws.on('error', (err) => {
      console.error('[SMS gateway] WebSocket error:', err.message);
    });
  }

  wss.on('connection', setupConnection);

  subscriber.on('message', (_channel, jobId) => {
    if (activeClient && activeClient.readyState === activeClient.OPEN) {
      deliverNextJob(activeClient).catch((err) => {
        console.error('[SMS gateway] Failed to deliver job:', err.message);
      });
    }
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        closeWithReason(ws, 4001, 'heartbeat_timeout');
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);

  wss.on('close', () => {
    clearInterval(heartbeat);
    subscriber.quit().catch(() => {});
  });

  console.log(`SMS gateway WebSocket listening on ${WS_PATH}`);
  return wss;
}

module.exports = {
  attachSmsGateway,
  WS_PATH,
};
