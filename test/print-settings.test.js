const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDb } = require('../src/db/partners-db');
const {
  getPrintGatewayToken,
  getPrintSettingsPublic,
  isPrintGatewayEnabled,
  savePrintSettings,
} = require('../src/print/print-settings');
const { createPrintJob, listPendingPrintJobs } = require('../src/db/print-jobs');
const { enqueueTestPrint } = require('../src/print/print-dispatch');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-print-settings-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('print gateway settings', () => {
  let dbPath;
  let db;
  const previousToken = process.env.PRINT_GATEWAY_TOKEN;
  const previousEnabled = process.env.PRINT_GATEWAY_ENABLED;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
  });

  after(() => {
    if (previousToken == null) delete process.env.PRINT_GATEWAY_TOKEN;
    else process.env.PRINT_GATEWAY_TOKEN = previousToken;
    if (previousEnabled == null) delete process.env.PRINT_GATEWAY_ENABLED;
    else process.env.PRINT_GATEWAY_ENABLED = previousEnabled;
    db.close();
    removeDbFiles(dbPath);
  });

  beforeEach(() => {
    delete process.env.PRINT_GATEWAY_TOKEN;
    delete process.env.PRINT_GATEWAY_ENABLED;
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare(
      "DELETE FROM app_settings WHERE key IN ('print_gateway_enabled', 'print_gateway_token')"
    ).run();
  });

  it('falls back to env token until a database token is saved', () => {
    process.env.PRINT_GATEWAY_TOKEN = 'env-token';
    assert.equal(getPrintGatewayToken(db), 'env-token');
    const publicSettings = getPrintSettingsPublic(db);
    assert.equal(publicSettings.token_configured, true);
    assert.equal(publicSettings.token_source, 'env');
    assert.equal(publicSettings.token_hint, 'oken');
    assert.equal(isPrintGatewayEnabled(db), true);

    savePrintSettings(db, { token: 'dev-token', enabled: true });
    assert.equal(getPrintGatewayToken(db), 'dev-token');
    const stored = getPrintSettingsPublic(db);
    assert.equal(stored.token_source, 'database');
    assert.equal(stored.token_hint, 'oken');
    assert.equal(stored.enabled, true);
  });

  it('can disable the gateway in the database without removing the token', () => {
    savePrintSettings(db, { token: 'keep-me', enabled: false });
    assert.equal(getPrintGatewayToken(db), 'keep-me');
    assert.equal(isPrintGatewayEnabled(db), false);
  });

  it('treats PRINT_GATEWAY_ENABLED=0 as a hard off switch', () => {
    process.env.PRINT_GATEWAY_ENABLED = '0';
    savePrintSettings(db, { token: 'still-there', enabled: true });
    assert.equal(isPrintGatewayEnabled(db), false);
    assert.equal(getPrintSettingsPublic(db).env_forced_off, true);
  });

  it('clears the database token and falls back to env', () => {
    process.env.PRINT_GATEWAY_TOKEN = 'from-env';
    savePrintSettings(db, { token: 'from-db' });
    assert.equal(getPrintGatewayToken(db), 'from-db');
    savePrintSettings(db, { clear_token: true });
    assert.equal(getPrintGatewayToken(db), 'from-env');
    assert.equal(getPrintSettingsPublic(db).token_source, 'env');
  });

  it('enqueues a test label job', () => {
    const job = enqueueTestPrint(db, { kind: 'label', location_id: 3, printer_name: 'Test labels' });
    assert.equal(job.kind, 'label');
    assert.equal(job.printerName, 'Test labels');
    assert.equal(job.data.serial, 'SR00000000');
    assert.equal(job.locationId, '3');
    assert.equal(listPendingPrintJobs(db, '3').some((item) => item.id === job.id), true);
    const created = createPrintJob(db, { kind: 'receipt', data: { title: 'x' } });
    assert.equal(created.kind, 'receipt');
  });

  it('requires a printer name for test print', () => {
    assert.throws(() => enqueueTestPrint(db, { kind: 'label' }), /PRINT_PRINTER_REQUIRED/);
  });
});
