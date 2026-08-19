const { WebSocketServer } = require('ws');
const { URL } = require('url');
const { listPrintTemplates } = require('../db/print-templates');
const { ensurePrintJobTables, listPendingPrintJobs, markPrintJobResult, protocolJob } = require('../db/print-jobs');
const { getPrintGatewayToken, isPrintGatewayEnabled, WS_PATH } = require('./print-settings');
const {
  normalizePrinters,
  matchesJob,
  listEnabledPrintersFromStations,
  findEnabledPrinter,
} = require('./print-station-match');

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

let hub = null;

function getPrintHub() {
  return hub;
}

function attachPrintGateway(httpServer, { db }) {
  ensurePrintJobTables(db);
  if (!isPrintGatewayEnabled(db)) {
    console.warn('Print gateway waiting for token (set PRINT_GATEWAY_TOKEN or enable it in settings).');
  }

  const stations = new Map();
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname !== WS_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  function openStations() {
    return [...stations.values()].filter((station) => station.ws.readyState === station.ws.OPEN);
  }

  function deliverJob(job) {
    if (!job || (job.status && job.status !== 'pending')) return 0;
    let sent = 0;
    for (const station of openStations()) {
      if (!matchesJob(station, job)) continue;
      sendJson(station.ws, { type: 'print', job: protocolJob(job) });
      sent += 1;
    }
    return sent;
  }

  function pushTemplates() {
    const templates = listPrintTemplates(db);
    for (const station of openStations()) {
      sendJson(station.ws, { type: 'templates', templates });
    }
  }

  function setupConnection(ws) {
    ws.isAlive = true;
    ws.authenticated = false;
    const authTimer = setTimeout(() => {
      if (!ws.authenticated) closeWithReason(ws, 4401, 'auth_timeout');
    }, AUTH_TIMEOUT_MS);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
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
        if (!isPrintGatewayEnabled(db)) {
          sendJson(ws, { type: 'auth_failed', message: 'disabled' });
          closeWithReason(ws, 4403, 'disabled');
          return;
        }
        const gatewayToken = getPrintGatewayToken(db);
        const token = String(msg.token || '').trim();
        if (!gatewayToken || token !== gatewayToken) {
          sendJson(ws, { type: 'auth_failed', message: 'invalid_token' });
          closeWithReason(ws, 4403, 'invalid_token');
          return;
        }
        ws.authenticated = true;
        clearTimeout(authTimer);
        const stationId = String(msg.stationId || '').trim() || `station-${Date.now()}`;
        const locationId = msg.locationId == null || msg.locationId === '' ? '' : String(msg.locationId);
        const station = {
          ws,
          stationId,
          locationId,
          stationName: String(msg.stationName || ''),
          printers: normalizePrinters(msg.printers),
        };
        stations.set(stationId, station);
        ws.stationId = stationId;
        sendJson(ws, {
          type: 'hello',
          templates: listPrintTemplates(db),
          jobs: listPendingPrintJobs(db, locationId).filter((job) => matchesJob(station, job)).map(protocolJob),
        });
        return;
      }

      if (msg.type === 'ping') {
        sendJson(ws, { type: 'pong' });
        return;
      }

      if (msg.type === 'pong') {
        ws.isAlive = true;
        return;
      }

      if (msg.type === 'printers') {
        const station = stations.get(ws.stationId);
        if (station) station.printers = normalizePrinters(msg.printers);
        return;
      }

      if (msg.type === 'result') {
        markPrintJobResult(db, String(msg.jobId || ''), Boolean(msg.ok), msg.error);
        return;
      }

      sendJson(ws, { type: 'error', message: 'Unknown message type' });
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (ws.stationId) stations.delete(ws.stationId);
    });

    ws.on('error', (err) => {
      console.error('[Print gateway] WebSocket error:', err.message);
    });
  }

  wss.on('connection', setupConnection);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        closeWithReason(ws, 4001, 'heartbeat_timeout');
        continue;
      }
      ws.isAlive = false;
      sendJson(ws, { type: 'ping' });
    }
  }, HEARTBEAT_MS);

  wss.on('close', () => clearInterval(heartbeat));

  hub = {
    deliverJob,
    pushTemplates,
    connectedCount() {
      return stations.size;
    },
    listStations() {
      return [...stations.values()].map((station) => ({
        station_id: station.stationId,
        station_name: station.stationName || '',
        location_id: station.locationId || '',
        printers: (station.printers || []).map((printer) => ({
          name: printer.name,
          kind: printer.kind,
          enabled: Boolean(printer.enabled),
        })),
      }));
    },
    listEnabledPrinters(filters = {}) {
      return listEnabledPrintersFromStations(openStations(), filters);
    },
    findEnabledPrinter(filters = {}) {
      return findEnabledPrinter(openStations(), filters);
    },
  };

  console.log(`Print gateway WebSocket listening on ${WS_PATH}`);
  return hub;
}

module.exports = {
  attachPrintGateway,
  getPrintHub,
  isPrintGatewayEnabled,
  WS_PATH,
};
