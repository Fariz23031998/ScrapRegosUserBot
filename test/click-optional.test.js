const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { openDb, createOrder, getOrderById } = require('../src/db/partners-db');
const {
  formatClickUrl,
  formatClickUrlSafe,
  verifyClickSignature,
  isClickConfigured,
  isClickPaymentEnabled,
} = require('../src/payments/click');
const {
  getDefaultPaymentProvider,
  getPaymentOptionsForOrder,
} = require('../src/payments/payments-api');

const CLICK_ENV = [
  'CLICK_MERCHANT_ID',
  'CLICK_SERVICE_ID',
  'CLICK_MERCHANT_USER_ID',
  'CLICK_SECRET_KEY',
  'ENABLE_CLICK_PAYMENT',
];
const PAYME_ENV = ['PAYME_MERCHANT_ID', 'PAYME_SECRET_KEY', 'PAYME_TEST_KEY', 'PAYME_TEST_MODE'];

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-click-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('CLICK payments disabled (ENABLE_CLICK_PAYMENT=0)', () => {
  let dbPath;
  let db;
  let previousEnv;

  before(() => {
    previousEnv = {};
    for (const key of [...CLICK_ENV, ...PAYME_ENV]) {
      previousEnv[key] = process.env[key];
    }
  });

  after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (db) {
      db.close();
      db = null;
    }
    if (dbPath) removeDbFiles(dbPath);
  });

  beforeEach(() => {
    // Mirror a production .env where CLICK is switched off and its keys are blank.
    process.env.ENABLE_CLICK_PAYMENT = '0';
    for (const key of ['CLICK_MERCHANT_ID', 'CLICK_SERVICE_ID', 'CLICK_MERCHANT_USER_ID', 'CLICK_SECRET_KEY']) {
      process.env[key] = '';
    }
    for (const key of PAYME_ENV) {
      delete process.env[key];
    }

    if (db) {
      db.close();
      db = null;
    }
    if (dbPath) removeDbFiles(dbPath);
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
  });

  function makeOrder({ provider = getDefaultPaymentProvider(), amount = 50000 } = {}) {
    const id = crypto.randomUUID();
    return createOrder(db, {
      id,
      telegramId: 501,
      botUserPhone: '+998901000001',
      clientPhone: '+998901112233',
      clientType: 'partner',
      amount,
      paymentProvider: provider,
      metadata: null,
    });
  }

  it('reports CLICK as unconfigured and disabled', () => {
    assert.equal(isClickConfigured(), false);
    assert.equal(isClickPaymentEnabled(), false);

    process.env.ENABLE_CLICK_PAYMENT = '1';
    assert.equal(isClickPaymentEnabled(), false, 'blank keys must keep CLICK disabled');
  });

  it('returns null instead of throwing when building a CLICK url', () => {
    assert.throws(() => formatClickUrl('order-1', 1000), /Missing CLICK_SERVICE_ID/);
    assert.equal(formatClickUrlSafe('order-1', 1000), null);
  });

  it('rejects CLICK webhook signatures without a secret key', () => {
    assert.equal(verifyClickSignature({ sign_string: 'anything' }), false);
    assert.equal(verifyClickSignature({}), false);
  });

  it('falls back to payme as the default order provider', () => {
    assert.equal(getDefaultPaymentProvider(), 'payme');

    const order = makeOrder();
    assert.equal(getOrderById(db, order.id).payment_provider, 'payme');
  });

  it('builds payment options without a CLICK entry and without throwing', async () => {
    const order = makeOrder();
    const options = await getPaymentOptionsForOrder(db, order.id);

    assert.equal(options.order.id, order.id);
    assert.ok(!options.payments.some((item) => item.provider === 'click'));
  });
});
