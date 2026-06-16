require('dotenv').config();

const path = require('path');
const express = require('express');
const { openDb, getOrderById, createPayment, markOrderPaid } = require('./lib/partners-db');
const { verifyClickSignature } = require('./lib/click');
const { getPaymentOptionsForOrder, getPublicDir, isOrderId } = require('./lib/payments-api');

const app = express();
const db = openDb();
const port = Number(process.env.CLICK_SERVER_PORT || 3000);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(getPublicDir()));

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

app.get('/:orderId', (req, res, next) => {
  if (!isOrderId(req.params.orderId)) {
    return next();
  }
  res.sendFile(path.join(getPublicDir(), 'pay.html'));
});

app.get('/api/orders/:orderId/payments', (req, res) => {
  const data = getPaymentOptionsForOrder(db, req.params.orderId);
  if (!data) {
    return res.status(404).json({ message: 'Заказ не найден.' });
  }
  return res.json(data);
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
  console.log(`CLICK server listening on :${port}`);
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
