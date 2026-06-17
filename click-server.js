require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const path = require('path');
const express = require('express');
const { openDb, getOrderById, createPayment, markOrderPaid } = require('./lib/partners-db');
const { verifyClickSignature } = require('./lib/click');
const { syncPaymeReceiptStatus } = require('./lib/payme-receipts');
const { getPaymentOptionsForOrder, getPublicDir, isOrderId } = require('./lib/payments-api');
const { createBotAdminRouter } = require('./lib/bot-admin');

const app = express();
const db = openDb();
const port = Number(process.env.CLICK_SERVER_PORT || 3000);
const publicStatic = express.static(getPublicDir());

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use((req, res, next) => {
  if (req.path === '/bot-admin' || req.path.startsWith('/bot-admin/')) {
    return next();
  }
  return publicStatic(req, res, next);
});

app.get('/brand-logo.png', (_req, res) => {
  res.sendFile(path.join(__dirname, '8c69cd56997dd51c986e951e0d553f14582ea8b4.png'));
});

function amountsEqual(payloadAmount, orderAmount) {
  return Number(payloadAmount) === Number(orderAmount);
}

app.get('/pay', (req, res) => {
  const orderId = String(req.query.order_id || '').trim();
  if (isOrderId(orderId)) {
    return res.redirect(301, `/${orderId}`);
  }
  res.sendFile(path.join(getPublicDir(), 'pay.html'));
});

app.use('/bot-admin', createBotAdminRouter(db));

app.get('/:orderId', (req, res, next) => {
  const orderId = String(req.params.orderId || '').trim();
  if (isOrderId(orderId) || getOrderById(db, orderId)) {
    return res.sendFile(path.join(getPublicDir(), 'pay.html'));
  }
  return next();
});

app.get('/api/orders/:orderId/payments', async (req, res) => {
  try {
    const data = await getPaymentOptionsForOrder(db, req.params.orderId);
    if (!data) {
      return res.status(404).json({ message: 'Заказ не найден.' });
    }
    return res.json(data);
  } catch (error) {
    console.error('Payment options error:', error);
    return res.status(500).json({ message: 'Не удалось подготовить способы оплаты.' });
  }
});

app.post('/api/orders/:orderId/payme/check', async (req, res) => {
  try {
    const order = getOrderById(db, req.params.orderId);
    if (!order) {
      return res.status(404).json({ message: 'Заказ не найден.' });
    }
    const result = await syncPaymeReceiptStatus(db, req.params.orderId);
    const updatedOrder = getOrderById(db, req.params.orderId);
    return res.json({
      ...result,
      order: updatedOrder
        ? {
            id: updatedOrder.id,
            status: updatedOrder.status,
            paid_at: updatedOrder.paid_at,
          }
        : null,
    });
  } catch (error) {
    console.error('Payme status check error:', error);
    return res.status(500).json({ message: 'Не удалось проверить статус оплаты Payme.' });
  }
});

app.post('/click/prepare', (req, res) => {
  const payload = req.body ?? {};

  if (!verifyClickSignature(payload)) {
    return res.json({ error: -1, error_note: 'SIGN CHECK FAILED' });
  }

  const order = getOrderById(db, payload.merchant_trans_id);
  if (!order || order.status !== 'pending') {
    return res.json({ error: -5, error_note: 'Order not found' });
  }

  if (!amountsEqual(payload.amount, order.amount)) {
    return res.json({ error: -2, error_note: 'Incorrect amount' });
  }

  return res.json({
    click_trans_id: payload.click_trans_id,
    merchant_trans_id: payload.merchant_trans_id,
    merchant_prepare_id: order.id,
    error: 0,
    error_note: 'Success',
  });
});

app.post('/click/complete', (req, res) => {
  const payload = req.body ?? {};

  if (!verifyClickSignature(payload)) {
    return res.json({ error: -1, error_note: 'SIGN CHECK FAILED' });
  }

  const order = getOrderById(db, payload.merchant_trans_id);
  if (!order || order.status !== 'pending') {
    return res.json({ error: -5, error_note: 'Order not found' });
  }

  if (!amountsEqual(payload.amount, order.amount)) {
    return res.json({ error: -2, error_note: 'Incorrect amount' });
  }

  createPayment(db, {
    orderId: order.id,
    telegramId: order.telegram_id,
    amount: order.amount,
    provider: 'click',
    clickTransId: payload.click_trans_id,
  });
  markOrderPaid(db, order.id, { clickTransId: payload.click_trans_id });

  return res.json({
    click_trans_id: payload.click_trans_id,
    merchant_trans_id: payload.merchant_trans_id,
    merchant_confirm_id: order.id,
    error: 0,
    error_note: 'Success',
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  const adminConfigured = Boolean(
    process.env.BOT_ADMIN_LOGIN?.trim() && process.env.BOT_ADMIN_PASSWORD?.trim()
  );
  console.log(`CLICK server listening on :${port}`);
  if (!adminConfigured) {
    console.warn('BOT_ADMIN_LOGIN / BOT_ADMIN_PASSWORD not set — /bot-admin/ is disabled.');
  }
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
