const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  openDb,
  createOrder,
  getOrderById,
  setOrderPaymeReceiptId,
  listPendingOrdersWithPaymeReceipt,
  markOrderPaid,
} = require('../src/db/partners-db');

const paymeApiPath = require.resolve('../src/payments/payme-api');
const paymeReceiptsPath = require.resolve('../src/payments/payme-receipts');
const paymeReconcilePath = require.resolve('../src/payments/payme-reconcile');
const paymentNotificationPath = require.resolve('../src/bot/payment-notification');
const paymentsApiPath = require.resolve('../src/payments/payments-api');

const realPaymeApi = require('../src/payments/payme-api');
const realPaymentNotification = require('../src/bot/payment-notification');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-payme-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

function installMocks({ checkReceipt, createReceipt, notifyResult = { sent: true } }) {
  const notifyCalls = [];
  require.cache[paymeApiPath].exports = {
    ...realPaymeApi,
    checkReceipt,
    createReceipt,
  };
  require.cache[paymentNotificationPath].exports = {
    ...realPaymentNotification,
    notifyCreatorOrderPaid: async (...args) => {
      notifyCalls.push(args);
      return typeof notifyResult === 'function' ? notifyResult(...args) : { ...notifyResult };
    },
  };

  delete require.cache[paymeReceiptsPath];
  delete require.cache[paymeReconcilePath];
  delete require.cache[paymentsApiPath];

  return {
    receipts: require('../src/payments/payme-receipts'),
    reconcile: require('../src/payments/payme-reconcile'),
    paymentsApi: require('../src/payments/payments-api'),
    notifyCalls,
  };
}

function restoreModules() {
  require.cache[paymeApiPath].exports = realPaymeApi;
  require.cache[paymentNotificationPath].exports = realPaymentNotification;
  delete require.cache[paymeReceiptsPath];
  delete require.cache[paymeReconcilePath];
  delete require.cache[paymentsApiPath];
  require('../src/payments/payme-receipts');
  require('../src/payments/payme-reconcile');
  require('../src/payments/payments-api');
}

describe('Payme receipt reuse and sync', () => {
  let dbPath;
  let db;
  let previousEnv;
  let createCalls;

  before(() => {
    previousEnv = {
      PAYME_TEST_MODE: process.env.PAYME_TEST_MODE,
      ENABLE_CLICK_PAYMENT: process.env.ENABLE_CLICK_PAYMENT,
      PAYME_RECEIPT_TTL_MS: process.env.PAYME_RECEIPT_TTL_MS,
    };
  });

  after(() => {
    restoreModules();
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
    process.env.PAYME_TEST_MODE = '1';
    process.env.ENABLE_CLICK_PAYMENT = '0';
    delete process.env.PAYME_RECEIPT_TTL_MS;

    if (db) {
      db.close();
      db = null;
    }
    if (dbPath) removeDbFiles(dbPath);
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    createCalls = [];
  });

  function makeOrder(amount = 500) {
    return createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 777,
      botUserPhone: '+998901000001',
      clientPhone: '+998901112233',
      clientType: 'partner',
      amount,
      paymentProvider: 'payme',
      metadata: null,
    });
  }

  it('marks order paid and does not create when existing receipt is paid', async () => {
    const order = makeOrder();
    const receiptId = 'receipt-paid-1';
    setOrderPaymeReceiptId(db, order.id, receiptId, Date.now());

    const { receipts } = installMocks({
      checkReceipt: async (id) => {
        assert.equal(id, receiptId);
        return { state: realPaymeApi.RECEIPT_STATE_PAID };
      },
      createReceipt: async () => {
        createCalls.push(true);
        throw new Error('createReceipt must not be called');
      },
    });

    const url = await receipts.getOrCreatePaymeCheckoutUrl(db, order);
    assert.equal(url, null);
    assert.equal(createCalls.length, 0);

    const updated = getOrderById(db, order.id);
    assert.equal(updated.status, 'paid');
    assert.equal(updated.payme_receipt_id, receiptId);
    assert.equal(updated.payment_provider, 'payme');
  });

  it('reuses open receipt and does not create a duplicate', async () => {
    const order = makeOrder();
    const receiptId = 'receipt-open-1';
    setOrderPaymeReceiptId(db, order.id, receiptId, Date.now());

    const { receipts } = installMocks({
      checkReceipt: async () => ({ state: realPaymeApi.RECEIPT_STATE_OPEN }),
      createReceipt: async () => {
        createCalls.push(true);
        throw new Error('createReceipt must not be called');
      },
    });

    const url = await receipts.getOrCreatePaymeCheckoutUrl(db, order);
    assert.equal(url, `https://test.paycom.uz/${receiptId}`);
    assert.equal(createCalls.length, 0);
    assert.equal(getOrderById(db, order.id).status, 'pending');
  });

  it('reuses existing receipt when checkReceipt fails (fail closed)', async () => {
    const order = makeOrder();
    const receiptId = 'receipt-error-1';
    setOrderPaymeReceiptId(db, order.id, receiptId, Date.now());

    const { receipts } = installMocks({
      checkReceipt: async () => {
        throw new Error('network down');
      },
      createReceipt: async () => {
        createCalls.push(true);
        throw new Error('createReceipt must not be called');
      },
    });

    const url = await receipts.getOrCreatePaymeCheckoutUrl(db, order);
    assert.equal(url, `https://test.paycom.uz/${receiptId}`);
    assert.equal(createCalls.length, 0);
  });

  it('syncPaymeReceiptStatus is idempotent when already paid', async () => {
    const order = makeOrder();
    const receiptId = 'receipt-sync-1';
    setOrderPaymeReceiptId(db, order.id, receiptId, Date.now());

    const { receipts } = installMocks({
      checkReceipt: async () => ({ state: realPaymeApi.RECEIPT_STATE_PAID }),
      createReceipt: async () => {
        throw new Error('unused');
      },
    });

    const first = await receipts.syncPaymeReceiptStatus(db, order.id);
    assert.equal(first.status, 'paid');

    const second = await receipts.syncPaymeReceiptStatus(db, order.id);
    assert.equal(second.status, 'paid');
    assert.equal(getOrderById(db, order.id).status, 'paid');

    const payments = db.prepare('SELECT * FROM payments WHERE order_id = ?').all(order.id);
    assert.equal(payments.length, 1);
  });

  it('reconciler marks pending orders with paid receipts', async () => {
    const order = makeOrder();
    const receiptId = 'receipt-reconcile-1';
    setOrderPaymeReceiptId(db, order.id, receiptId, Date.now());

    assert.equal(listPendingOrdersWithPaymeReceipt(db).length, 1);

    const { reconcile } = installMocks({
      checkReceipt: async () => ({ state: realPaymeApi.RECEIPT_STATE_PAID }),
      createReceipt: async () => {
        throw new Error('unused');
      },
    });

    const result = await reconcile.reconcilePendingPaymeReceipts(db);
    assert.equal(result.checked, 1);
    assert.equal(result.paid, 1);
    assert.equal(result.errors, 0);
    assert.equal(getOrderById(db, order.id).status, 'paid');
    assert.equal(listPendingOrdersWithPaymeReceipt(db).length, 0);
  });

  it('getPaymentOptionsForOrder syncs paid receipt before offering Payme', async () => {
    const order = makeOrder();
    const receiptId = 'receipt-options-1';
    setOrderPaymeReceiptId(db, order.id, receiptId, Date.now());

    const { paymentsApi } = installMocks({
      checkReceipt: async () => ({ state: realPaymeApi.RECEIPT_STATE_PAID }),
      createReceipt: async () => {
        createCalls.push(true);
        throw new Error('createReceipt must not be called');
      },
    });

    const options = await paymentsApi.getPaymentOptionsForOrder(db, order.id);
    assert.equal(options.order.status, 'paid');
    assert.equal(options.payments.length, 0);
    assert.equal(createCalls.length, 0);
  });

  it('markOrderPaid claimed flag stays false on second claim', () => {
    const order = makeOrder();
    const first = markOrderPaid(db, order.id, { transactionId: 't1', provider: 'payme' });
    assert.equal(first.claimed, true);
    const second = markOrderPaid(db, order.id, { transactionId: 't1', provider: 'payme' });
    assert.equal(second.claimed, false);
  });

  it('retries employee notify for paid-but-unnotified orders', async () => {
    const order = makeOrder();
    const receiptId = 'receipt-notify-retry';
    setOrderPaymeReceiptId(db, order.id, receiptId, Date.now());
    markOrderPaid(db, order.id, { transactionId: receiptId, provider: 'payme' });
    assert.equal(getOrderById(db, order.id).paid_notified_at, null);

    let attempt = 0;
    const { receipts, notifyCalls } = installMocks({
      checkReceipt: async () => ({ state: realPaymeApi.RECEIPT_STATE_PAID }),
      createReceipt: async () => {
        throw new Error('unused');
      },
      notifyResult: () => {
        attempt += 1;
        if (attempt === 1) {
          return { sent: false, reason: 'send_failed' };
        }
        return { sent: true };
      },
    });

    const first = await receipts.syncPaymeReceiptStatus(db, order.id);
    assert.equal(first.status, 'paid');
    assert.equal(getOrderById(db, order.id).paid_notified_at, null);
    assert.equal(notifyCalls.length, 1);

    const second = await receipts.syncPaymeReceiptStatus(db, order.id);
    assert.equal(second.status, 'paid');
    assert.ok(getOrderById(db, order.id).paid_notified_at);
    assert.equal(notifyCalls.length, 2);

    const third = await receipts.syncPaymeReceiptStatus(db, order.id);
    assert.equal(third.status, 'paid');
    assert.equal(notifyCalls.length, 2, 'already notified orders must not resend');
  });

  it('still notifies when createPayment would have blocked the old path', async () => {
    const order = makeOrder();
    const receiptId = 'receipt-notify-after-payment-row';
    setOrderPaymeReceiptId(db, order.id, receiptId, Date.now());

    const { receipts, notifyCalls } = installMocks({
      checkReceipt: async () => ({ state: realPaymeApi.RECEIPT_STATE_PAID }),
      createReceipt: async () => {
        throw new Error('unused');
      },
    });

    await receipts.syncPaymeReceiptStatus(db, order.id);
    assert.equal(getOrderById(db, order.id).status, 'paid');
    assert.ok(getOrderById(db, order.id).paid_notified_at);
    assert.equal(notifyCalls.length, 1);
  });
});
