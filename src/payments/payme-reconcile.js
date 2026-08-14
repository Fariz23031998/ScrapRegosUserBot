const { listPaymeOrdersForReconcile, getOrderById } = require('../db/partners-db');
const { getReceiptTtlMs, syncPaymeReceiptStatus } = require('./payme-receipts');

const DEFAULT_INTERVAL_MS = 450_000;
const DEFAULT_CONCURRENCY = 3;

function getReconcileIntervalMs() {
  const value = Number(process.env.PAYME_RECONCILE_INTERVAL_MS);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_INTERVAL_MS;
  }
  return value;
}

function getReconcileConcurrency() {
  const value = Number(process.env.PAYME_RECONCILE_CONCURRENCY);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_CONCURRENCY;
  }
  return Math.min(Math.floor(value), 10);
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = [];
  let index = 0;

  async function runNext() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => runNext());
  await Promise.all(runners);
  return results;
}

function getPendingReconcileCreatedAfterMs({
  now = Date.now(),
  ttlMs = getReceiptTtlMs(),
  graceMs = getReconcileIntervalMs(),
} = {}) {
  return now - (Number(ttlMs) + Number(graceMs));
}

async function reconcilePendingPaymeReceipts(db, { concurrency = getReconcileConcurrency() } = {}) {
  const orders = listPaymeOrdersForReconcile(db, {
    pendingCreatedAfterMs: getPendingReconcileCreatedAfterMs(),
  });
  if (!orders.length) {
    return { checked: 0, paid: 0, notified: 0, errors: 0 };
  }

  let paid = 0;
  let notified = 0;
  let errors = 0;

  await mapWithConcurrency(orders, concurrency, async (order) => {
    try {
      const before = order;
      const result = await syncPaymeReceiptStatus(db, order.id);
      if (result.status === 'paid') {
        if (before.status !== 'paid') {
          paid += 1;
          console.log(`Payme reconcile: order ${order.id} marked paid (receipt ${result.receiptId})`);
        }
        const after = getOrderById(db, order.id);
        if (after?.paid_notified_at && !before.paid_notified_at) {
          notified += 1;
        }
      }
    } catch (error) {
      errors += 1;
      console.error(
        `Payme reconcile failed for order ${order.id}:`,
        error.message || error
      );
    }
  });

  return { checked: orders.length, paid, notified, errors };
}

function startPaymeReceiptReconciler(db, { intervalMs = getReconcileIntervalMs() } = {}) {
  let running = false;

  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await reconcilePendingPaymeReceipts(db);
    } catch (error) {
      console.error('Payme reconcile tick failed:', error.message || error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  // First pass shortly after boot so recently paid mobile checkouts sync without waiting a full interval.
  const initial = setTimeout(tick, Math.min(5_000, intervalMs));
  if (typeof initial.unref === 'function') {
    initial.unref();
  }

  console.log(`Payme receipt reconciler started (every ${intervalMs}ms)`);
  return {
    stop() {
      clearInterval(timer);
      clearTimeout(initial);
    },
    tick,
  };
}

module.exports = {
  reconcilePendingPaymeReceipts,
  startPaymeReceiptReconciler,
  getReconcileIntervalMs,
  getReconcileConcurrency,
  getPendingReconcileCreatedAfterMs,
};
