const path = require('path');
const { envPath, brandLogoPath } = require('../../src/paths');
require('dotenv').config({ path: envPath() });

const http = require('http');
const express = require('express');
const { openDb, getOrderById, createPayment, markOrderPaid } = require('../../src/db/partners-db');
const { verifyClickSignature, isClickPaymentEnabled } = require('../../src/payments/click');
const { syncPaymeReceiptStatus } = require('../../src/payments/payme-receipts');
const { getPaymentOptionsForOrder, getPublicDir, isOrderId } = require('../../src/payments/payments-api');
const { createBotAdminRouter } = require('../../src/admin/bot-admin');
const { attachSmsGateway } = require('../../src/sms/sms-gateway-ws');
const { notifyCreatorOrderPaid } = require('../../src/bot/payment-notification');
const { getServicePricesCatalog } = require('../../src/db/service-prices');

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
  res.sendFile(brandLogoPath());
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

app.get('/prices', (_req, res) => {
  res.sendFile(path.join(getPublicDir(), 'prices.html'));
});

app.get('/api/prices', (_req, res) => {
  try {
    return res.json(getServicePricesCatalog(db));
  } catch (error) {
    console.error('Public prices error:', error);
    return res.status(500).json({ message: 'Не удалось загрузить прайс.' });
  }
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

  if (!isClickPaymentEnabled()) {
    return res.json({ error: -9, error_note: 'CLICK payments are disabled' });
  }

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

app.post('/click/complete', async (req, res) => {
  const payload = req.body ?? {};

  if (!isClickPaymentEnabled()) {
    return res.json({ error: -9, error_note: 'CLICK payments are disabled' });
  }

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

  const { claimed, order: paidOrder } = markOrderPaid(db, order.id, {
    clickTransId: payload.click_trans_id,
    provider: 'click',
  });

  if (claimed) {
    createPayment(db, {
      orderId: order.id,
      telegramId: order.telegram_id,
      amount: order.amount,
      provider: 'click',
      clickTransId: payload.click_trans_id,
    });
    await notifyCreatorOrderPaid(paidOrder || order, { provider: 'click', db });
  }

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

const server = http.createServer(app);
attachSmsGateway(server, { db });

server.listen(port, () => {
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
