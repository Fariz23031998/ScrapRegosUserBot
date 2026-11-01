import type { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { envPath, brandLogoPath, botAdminPublicDir, botAdminUiDistDir } from '../../src/paths';
import dotenv from 'dotenv';
import http from 'http';
import express from 'express';
import { openDb, getOrderById, createPayment, markOrderPaid } from '../../src/db/partners-db';
import { verifyClickSignature, isClickPaymentEnabled } from '../../src/payments/click';
import { syncPaymeReceiptStatus } from '../../src/payments/payme-receipts';
import { startPaymeReceiptReconciler } from '../../src/payments/payme-reconcile';
import { startTaskReminderWorker } from '../../src/bot/task-reminder';
import { getPaymentOptionsForOrder, getPublicDir, isOrderId } from '../../src/payments/payments-api';
import { createBotAdminRouter } from '../../src/admin/bot-admin';
import { attachSmsGateway } from '../../src/sms/sms-gateway-ws';
import { attachPrintGateway } from '../../src/print/print-gateway-ws';
import { ensureCreatorPaidNotification } from '../../src/bot/payment-notification';
import { getServicePricesCatalog } from '../../src/db/service-prices';
import { sendVersionedHtmlFile } from '../../src/http/asset-cache';
import { applyCors } from '../../src/http/cors';
import { createAppBodyParsers, payloadTooLargeHandler } from '../../src/http/body-parser';
import { createRegosTicketWebhookHandler, createRegosTicketWebhookRouter } from '../../src/integrations/regos-ticket-webhook';

dotenv.config({ path: envPath() });

const app = express();
const db = openDb();
const port = Number(process.env.CLICK_SERVER_PORT || 3000);
const publicStatic = express.static(getPublicDir());

app.use(applyCors);
app.use(createAppBodyParsers());
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/bot-admin' || req.path.startsWith('/bot-admin/')) {
    return next();
  }
  return publicStatic(req, res, next);
});

app.get('/brand-logo.png', (_req: any, res: Response) => {
  res.sendFile(brandLogoPath());
});

function amountsEqual(payloadAmount?: any, orderAmount?: any) {
  return Number(payloadAmount) === Number(orderAmount);
}

app.get('/pay', (req: Request, res: Response) => {
  const orderId = String(req.query.order_id || '').trim();
  if (isOrderId(orderId)) {
    return res.redirect(301, `/${orderId}`);
  }
  return sendVersionedHtmlFile(res, path.join(getPublicDir(), 'pay.html'));
});

app.get('/prices', (_req: any, res: Response) => {
  return sendVersionedHtmlFile(res, path.join(getPublicDir(), 'prices.html'));
});

app.get('/api/prices', (_req: any, res: Response) => {
  try {
    return res.json(getServicePricesCatalog(db));
  } catch (error: any) {
    console.error('Public prices error:', error);
    return res.status(500).json({ message: 'Не удалось загрузить прайс.' });
  }
});

app.use(
  '/api/regos',
  createRegosTicketWebhookRouter({
    handler: createRegosTicketWebhookHandler({ db }),
  })
);

app.use('/bot-admin', createBotAdminRouter(db));

app.get('/:orderId', (req: Request, res: Response, next: NextFunction) => {
  const orderId = String(req.params.orderId || '').trim();
  if (isOrderId(orderId) || getOrderById(db, orderId)) {
    return sendVersionedHtmlFile(res, path.join(getPublicDir(), 'pay.html'));
  }
  return next();
});

app.get('/api/orders/:orderId/payments', async (req: Request, res: Response) => {
  try {
    const data = await getPaymentOptionsForOrder(db, req.params.orderId);
    if (!data) {
      return res.status(404).json({ message: 'Заказ не найден.' });
    }
    return res.json(data);
  } catch (error: any) {
    console.error('Payment options error:', error);
    return res.status(500).json({ message: 'Не удалось подготовить способы оплаты.' });
  }
});

app.post('/api/orders/:orderId/payme/check', async (req: Request, res: Response) => {
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
  } catch (error: any) {
    console.error('Payme status check error:', error);
    return res.status(500).json({ message: 'Не удалось проверить статус оплаты Payme.' });
  }
});

app.post('/click/prepare', (req: Request, res: Response) => {
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

app.post('/click/complete', async (req: Request, res: Response) => {
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
    try {
      createPayment(db, {
        orderId: order.id,
        telegramId: order.telegram_id,
        amount: order.amount,
        provider: 'click',
        clickTransId: payload.click_trans_id,
      });
    } catch (error: any) {
      console.error(
        `createPayment after Click claim failed for order ${order.id}:`,
        error.message || error
      );
    }
  }

  await ensureCreatorPaidNotification(db, paidOrder || order, { provider: 'click' });

  return res.json({
    click_trans_id: payload.click_trans_id,
    merchant_trans_id: payload.merchant_trans_id,
    merchant_confirm_id: order.id,
    error: 0,
    error_note: 'Success',
  });
});

app.get('/health', (_req: any, res: Response) => {
  res.json({ ok: true });
});

app.use(payloadTooLargeHandler);

const adminCommonScript = path.join(botAdminPublicDir(), 'admin-common.js');
if (!fs.existsSync(adminCommonScript)) {
  throw new Error(`Missing ${adminCommonScript}. Run \`npm run build:browser\` before starting the server.`);
}

const server = http.createServer(app);
attachSmsGateway(server, { db });
attachPrintGateway(server, { db });

const paymeReconciler = startPaymeReceiptReconciler(db);
const taskReminderWorker = startTaskReminderWorker(db);

server.listen(port, () => {
  const adminConfigured = Boolean(
    process.env.BOT_ADMIN_LOGIN?.trim() && process.env.BOT_ADMIN_PASSWORD?.trim()
  );
  const legacyForced = String(process.env.BOT_ADMIN_USE_LEGACY_UI || '').trim() === '1';
  const reactUiReady = !legacyForced && fs.existsSync(path.join(botAdminUiDistDir(), 'index.html'));
  console.log(`CLICK server listening on :${port}`);
  if (!adminConfigured) {
    console.warn('BOT_ADMIN_LOGIN / BOT_ADMIN_PASSWORD not set — /bot-admin/ is disabled.');
  } else if (reactUiReady) {
    console.log('Bot admin UI: React SPA (bot-admin-ui/dist)');
  } else if (legacyForced) {
    console.warn('Bot admin UI: legacy public/bot-admin (BOT_ADMIN_USE_LEGACY_UI=1)');
  } else {
    console.warn(
      'Bot admin UI: legacy public/bot-admin — run `npm run bot-admin-ui:build` to enable the React SPA.'
    );
  }
});

process.on('SIGINT', () => {
  paymeReconciler.stop();
  taskReminderWorker.stop();
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  paymeReconciler.stop();
  taskReminderWorker.stop();
  db.close();
  process.exit(0);
});
