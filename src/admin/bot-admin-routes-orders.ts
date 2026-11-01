import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { listEmployeeUsers } from '../db/bot-users-db';
import { buildAuditDetails } from '../db/admin-audit-logs';
import { getSessionActor, actorHasPermission, requireRight, requireAnyRight } from './bot-admin-auth';
import { createOrder, listOrders, getOrderById, deletePendingOrder, deletePaidCashOrder, markPendingOrderPaidCash } from '../db/partners-db';
import { addLink as addClientFirmLink } from '../db/client-firm-links';
import { looksLikePhone, normalizePhone, searchFirmAdmin, getFirmCardByTypeAndId } from '../bot/search-user';
import { parsePositiveAmount, formatOrderPaymentMessage, afterOrderCreated, createOrderFromContext } from '../bot/service-bot';
import {
  completeTechnicalSupportPurchase,
  durationLabel,
  formatAmount,
  formatSupportOrderPaymentMessage,
  NO_PRICES_TEXT,
  NO_PHONE_TEXT,
  DURATION_UNAVAILABLE_TEXT,
} from '../bot/technical-support-bot';
import { buildTariffInfoReply } from '../bot/tariff-info-bot';
import { listTechnicalSupportPrices } from '../db/technical-support';
import { enrichOrderParties } from '../bot/order-parties';
import { formatRenotifyResultMessage } from '../bot/order-actions-bot';
import { getOutboundBot } from '../bot/payment-notification';
import { withHtml } from '../bot/telegram-html';
import { formatPaymentPageUrl, getDefaultPaymentProvider } from '../payments/payments-api';
import { formatClickUrlSafe } from '../payments/click';
import { enqueueOrderPaymentSms } from '../sms/sms-queue';
import crypto from 'crypto';
import { resolveSessionBotUser, snapshotOrderForAudit, parsePaginationQuery, mapAdminOrderRow, resolveActorTelegramId, auditAdminChange } from './bot-admin-shared';

const FIRM_SEARCH_RIGHTS = ['tickets_read', 'clients_link_firm', 'open_admin_dashboard'];
const ORDER_EMPLOYEE_REQUIRED =
  'Создавать заказы можно только под учётной записью сотрудника с Telegram. Войдите через /open_dashboard или логин сотрудника.';
const TARIFF_LOAD_FAILED = 'Не удалось загрузить информацию о тарифе. Попробуйте позже.';

async function notifyServiceOrderCreated(db: Db, botUser: any, order: any, paymentPageUrl: any, paymentUrl: any) {
  const outboundBot = getOutboundBot();
  if (outboundBot) {
    try {
      await outboundBot.sendMessage(
        botUser.telegram_id,
        formatOrderPaymentMessage(order, paymentPageUrl, paymentUrl),
        withHtml()
      );
    } catch (err: any) {
      console.warn('[bot-admin] Creator notify failed:', err.message);
    }
    try {
      await afterOrderCreated(outboundBot, db, botUser, order, paymentPageUrl);
    } catch (err: any) {
      console.error('[bot-admin] Post-create notify failed:', err.message);
    }
    return;
  }
  try {
    await afterOrderCreated(null!, db, botUser, order, paymentPageUrl);
  } catch (err: any) {
    console.error('[bot-admin] Post-create SMS failed:', err.message);
  }
}

export function registerBotAdminOrderRoutes(router: any, deps: { db: Db }) {
  const { db } = deps;
  router.get(
    '/api/firm-search',
    requireAnyRight(db, FIRM_SEARCH_RIGHTS),
    async (req: Request, res: Response) => {
      const q = String(req.query.q || '').trim();
      if (!q) {
        return res.status(400).json({ message: 'Укажите поисковый запрос.' });
      }
      try {
        const result = (await searchFirmAdmin(q, db)) as {
          error?: boolean;
          found: boolean;
          message?: string;
          results?: any[];
        };
        if (result.error) {
          return res.status(502).json({ message: result.message || 'Не удалось выполнить поиск.' });
        }
        if (!result.found) {
          return res.json({ found: false, results: [] });
        }
        const results = (result.results || []).map((entry?: any) => ({
          type: entry.type || null,
          phone: entry.phone || null,
          recordId: entry.recordId ?? null,
          clientName: entry.clientName || null,
          message: entry.message || null,
          accountId: entry.accountId ?? null,
          accountLabel: entry.accountLabel || null,
          apiLogin: entry.apiLogin || null,
          tariff: entry.tariff || null,
        }));
        return res.json({ found: results.length > 0, results });
      } catch (error: any) {
        console.error('Firm search error:', error);
        return res.status(500).json({ message: 'Не удалось выполнить поиск.' });
      }
    }
  );

  router.get('/api/firms/:type/:recordId', requireRight(db, 'tickets_read'), async (req: Request, res: Response) => {
    try {
      const firm = await getFirmCardByTypeAndId(db, req.params.type, req.params.recordId);
      if (!firm) {
        return res.status(404).json({ message: 'Фирма не найдена.' });
      }
      return res.json({
        firm: {
          type: firm.type || null,
          recordId: firm.recordId ?? null,
          clientName: firm.clientName || null,
          phone: firm.phone || null,
          message: firm.message || null,
        },
      });
    } catch (error: any) {
      console.error('Get firm card error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить фирму.' });
    }
  });

  router.get('/api/orders', requireRight(db, 'orders_read'), (req: Request, res: Response) => {
    const query = String(req.query.q || '').trim();
    const clientPhone = String(req.query.client || req.query.client_phone || '').trim();
    const status = String(req.query.status || '').trim();
    const paymentProvider = String(req.query.payment || req.query.payment_provider || '').trim();
    const fromDate = String(req.query.from_date || '').trim();
    const toDate = String(req.query.to_date || '').trim();
    const telegramIdRaw = String(req.query.telegram_id || req.query.employee || '').trim();
    const telegramId = telegramIdRaw ? Number(telegramIdRaw) : undefined;
    let { page, limit, offset } = parsePaginationQuery(req);
    const options = {
      query: query || undefined,
      clientPhone: clientPhone || undefined,
      status: status || undefined,
      paymentProvider: paymentProvider || undefined,
      from: fromDate || undefined,
      to: toDate || undefined,
      telegramId: Number.isFinite(telegramId) && telegramId !== 0 ? telegramId : undefined,
      offset,
      limit,
      sort: req.query.sort,
    };
    let result = listOrders(db, options);
    const totalPages = Math.max(1, Math.ceil(result.total / limit) || 1);
    if (page > totalPages) {
      page = totalPages;
      options.offset = (page - 1) * limit;
      result = listOrders(db, options);
    }
    res.json({
      orders: result.orders.map((order?: any) => mapAdminOrderRow(enrichOrderParties(db, order))),
      total: result.total,
      page,
      limit,
      summary: result.summary,
    });
  });

  router.get('/api/orders/employees', requireRight(db, 'orders_read'), (_req: any, res: Response) => {
    const employees = listEmployeeUsers(db)
      .filter((user?: any) => user.telegram_id != null)
      .map((user?: any) => {
        const displayName =
          String(user.display_name || '').trim() ||
          [user.first_name, user.last_name].filter(Boolean).join(' ').trim() ||
          (user.username ? `@${String(user.username).replace(/^@/, '')}` : '') ||
          null;
        return {
          telegram_id: user.telegram_id,
          display_name: displayName,
          phone: user.phone || null,
        };
      })
      .sort((a?: any, b?: any) =>
        String(a.display_name || a.phone || a.telegram_id).localeCompare(
          String(b.display_name || b.phone || b.telegram_id),
          'ru'
        )
      );
    res.json({ employees });
  });

  router.post('/api/orders/:id/delete', requireRight(db, 'delete_unpaid_order'), (req: Request, res: Response) => {
    const orderId = String(req.params.id || '').trim();
    if (!orderId) {
      return res.status(400).json({ message: 'Не указан ID заказа.' });
    }
    const existing = getOrderById(db, orderId);
    const deleted = deletePendingOrder(db, orderId, resolveActorTelegramId(db, req));
    if (!deleted) {
      return res.status(409).json({
        message: 'Не удалось удалить заказ. Возможно, он уже оплачен или удалён.',
      });
    }
    auditAdminChange(db, req, {
      entityType: 'order',
      entityId: orderId,
      action: 'delete_unpaid',
      summary: `Удалён неоплаченный заказ ${orderId}`,
      details: buildAuditDetails({
        before: snapshotOrderForAudit(existing),
        after: null,
      }),
    });
    return res.json({ ok: true, message: 'Неоплаченный заказ удалён.' });
  });

  router.post('/api/orders/:id/delete-cash', requireRight(db, 'delete_cash_order'), (req: Request, res: Response) => {
    const orderId = String(req.params.id || '').trim();
    if (!orderId) {
      return res.status(400).json({ message: 'Не указан ID заказа.' });
    }
    const existing = getOrderById(db, orderId);
    const deleted = deletePaidCashOrder(db, orderId, resolveActorTelegramId(db, req));
    if (!deleted) {
      return res.status(409).json({
        message: 'Не удалось удалить заказ. Возможно, он не оплачен наличными или уже удалён.',
      });
    }
    auditAdminChange(db, req, {
      entityType: 'order',
      entityId: orderId,
      action: 'delete_cash',
      summary: `Удалён заказ „Наличные“ ${orderId}`,
      details: buildAuditDetails({
        before: snapshotOrderForAudit(existing),
        after: null,
      }),
    });
    return res.json({ ok: true, message: 'Заказ „Наличные“ удалён.' });
  });

  router.post('/api/orders/:id/paid-cash', requireRight(db, 'mark_paid_cash'), (req: Request, res: Response) => {
    const orderId = String(req.params.id || '').trim();
    if (!orderId) {
      return res.status(400).json({ message: 'Не указан ID заказа.' });
    }
    const existing = getOrderById(db, orderId);
    const closed = markPendingOrderPaidCash(db, orderId, resolveActorTelegramId(db, req));
    if (!closed) {
      return res.status(409).json({
        message: 'Не удалось закрыть заказ. Возможно, он уже оплачен или удалён.',
      });
    }
    const updated = getOrderById(db, orderId);
    auditAdminChange(db, req, {
      entityType: 'order',
      entityId: orderId,
      action: 'paid_cash',
      summary: `Заказ ${orderId} отмечен как оплаченный наличными`,
      details: buildAuditDetails({
        before: snapshotOrderForAudit(existing),
        after: snapshotOrderForAudit(updated || { ...existing, status: 'paid', payment_provider: 'cash' }),
      }),
    });
    return res.json({ ok: true, message: 'Заказ закрыт: оплачено наличными.' });
  });

  router.post(
    '/api/orders/:id/renotify',
    requireRight(db, 'renotify_order'),
    async (req: Request, res: Response) => {
      const orderId = String(req.params.id || '').trim();
      if (!orderId) {
        return res.status(400).json({ message: 'Не указан ID заказа.' });
      }
      const order = getOrderById(db, orderId);
      if (!order || order.status !== 'pending') {
        return res.status(409).json({
          message: 'Не удалось уведомить. Заказ не найден или уже оплачен.',
        });
      }
      try {
        const paymentPageUrl = formatPaymentPageUrl(order.id);
        const result = await enqueueOrderPaymentSms(db, order, paymentPageUrl);
        auditAdminChange(db, req, {
          entityType: 'order',
          entityId: orderId,
          action: 'renotify',
          summary: `Повторное уведомление по заказу ${orderId}`,
          details: buildAuditDetails({
            before: snapshotOrderForAudit(order),
            after: snapshotOrderForAudit(order),
            changes: null,
            result,
          }),
        });
        return res.json({
          ok: true,
          message: formatRenotifyResultMessage(result),
          result,
        });
      } catch (error: any) {
        console.error('Renotify order error:', error);
        return res.status(500).json({ message: 'Не удалось отправить уведомление.' });
      }
    }
  );

  router.post('/api/orders', requireRight(db, 'tickets_read'), express.json(), async (req: Request, res: Response) => {
    try {
      const botUser = resolveSessionBotUser(db, req);
      if (!botUser || botUser.telegram_id == null) {
        return res.status(403).json({
          message:
            'Создавать заказы можно только под учётной записью сотрудника с Telegram. Войдите через /open_dashboard или логин сотрудника.',
        });
      }

      const amount = parsePositiveAmount(req.body?.amount);
      if (!amount) {
        return res.status(400).json({ message: 'Укажите положительную сумму (целое число).' });
      }

      const clientPhoneRaw = String(req.body?.client_phone || '').trim();
      if (!clientPhoneRaw || !looksLikePhone(clientPhoneRaw)) {
        return res.status(400).json({ message: 'Укажите корректный телефон клиента.' });
      }
      const clientPhone = normalizePhone(clientPhoneRaw);

      let additionalPhone: any = null;
      const additionalRaw = String(req.body?.additional_phone || '').trim();
      if (additionalRaw) {
        if (!looksLikePhone(additionalRaw)) {
          return res.status(400).json({ message: 'Неверный дополнительный номер телефона.' });
        }
        additionalPhone = normalizePhone(additionalRaw);
      }

      const ticketIdRaw = req.body?.ticket_id;
      const ticketId =
        ticketIdRaw == null || ticketIdRaw === '' ? null : Number(ticketIdRaw);
      if (ticketIdRaw != null && ticketIdRaw !== '' && !Number.isFinite(ticketId)) {
        return res.status(400).json({ message: 'Некорректный ticket_id.' });
      }

      const clientName = req.body?.client_name != null ? String(req.body.client_name).trim() : '';
      const clientType = req.body?.client_type != null ? String(req.body.client_type).trim() : '';
      const firmMessage =
        req.body?.firm_message != null ? String(req.body.firm_message).trim() : '';
      const firmPhoneRaw =
        req.body?.firm_phone != null ? String(req.body.firm_phone).trim() : '';
      const recordIdRaw = req.body?.record_id;
      const recordId =
        recordIdRaw == null || recordIdRaw === '' ? null : recordIdRaw;
      const hasFirm = Boolean(clientType || recordId != null || firmMessage);

      const clientIdRaw = req.body?.client_id;
      const clientId =
        clientIdRaw == null || clientIdRaw === '' ? null : Number(clientIdRaw);
      if (clientIdRaw != null && clientIdRaw !== '' && (!Number.isInteger(clientId) || clientId! <= 0)) {
        return res.status(400).json({ message: 'Некорректный client_id.' });
      }

      const metadata = JSON.stringify({
        type: clientType || null,
        message: hasFirm
          ? firmMessage || null
          : ticketId != null
            ? `Заказ из тикета #${ticketId}`
            : null,
        recordId: recordId,
        clientName: clientName || null,
        source: 'bot-admin-tickets',
      });

      const id = crypto.randomUUID();
      const order = createOrder(db, {
        id,
        telegramId: botUser.telegram_id,
        botUserPhone: botUser.phone,
        clientPhone,
        clientType: clientType || null,
        additionalPhone,
        amount,
        paymentProvider: getDefaultPaymentProvider(),
        metadata,
        ticketId,
      });
      const detailedOrder = enrichOrderParties(db, order);
      const paymentUrl = formatClickUrlSafe(detailedOrder.id, detailedOrder.amount);
      const paymentPageUrl = formatPaymentPageUrl(order!.id);

      let firmLink: Unchecked = { linked: false, reason: 'skipped' };
      const actor = getSessionActor(req);
      const canLinkFirm = actorHasPermission(db, actor, 'clients_link_firm');
      const firmType = clientType || null;
      const firmRecordId = recordId;
      if (!canLinkFirm) {
        firmLink = { linked: false, reason: 'no_permission' };
      } else if (clientId == null) {
        firmLink = { linked: false, reason: 'no_client_id' };
      } else if (!firmType || firmRecordId == null || firmRecordId === '') {
        firmLink = { linked: false, reason: 'no_firm' };
      } else {
        try {
          const link = addClientFirmLink(db, {
            regos_client_id: clientId,
            type: firmType,
            recordId: firmRecordId,
            clientName: clientName || null,
            phone: firmPhoneRaw || clientPhone,
            message: firmMessage || null,
          });
          firmLink = { linked: true, id: link?.id ?? null };
        } catch (err: any) {
          if (err?.code === 'DUPLICATE_LINK') {
            firmLink = { linked: true, reason: 'already_linked' };
          } else {
            console.warn('[bot-admin] Auto firm link failed:', err.message);
            firmLink = { linked: false, reason: 'error', message: err.message };
          }
        }
      }

      await notifyServiceOrderCreated(db, botUser, detailedOrder, paymentPageUrl, paymentUrl);

      auditAdminChange(db, req, {
        entityType: 'order',
        entityId: order!.id,
        action: 'create',
        summary: `Создан заказ ${order!.id} на ${amount} сум`,
        details: buildAuditDetails({
          before: null,
          after: {
            ...snapshotOrderForAudit(detailedOrder),
            ticket_id: ticketId,
            firm_link: firmLink,
          },
        }),
      });

      return res.status(201).json({
        order: detailedOrder,
        payment_page_url: paymentPageUrl,
        firm_link: firmLink,
      });
    } catch (error: any) {
      console.error('Create order error:', error);
      return res.status(500).json({ message: 'Не удалось создать заказ.' });
    }
  });

  router.post(
    '/api/firm-service-orders',
    requireAnyRight(db, FIRM_SEARCH_RIGHTS),
    express.json(),
    async (req: Request, res: Response) => {
      try {
        const botUser = resolveSessionBotUser(db, req);
        if (!botUser || botUser.telegram_id == null) {
          return res.status(403).json({ message: ORDER_EMPLOYEE_REQUIRED });
        }

        const amount = parsePositiveAmount(req.body?.amount);
        if (!amount) {
          return res.status(400).json({ message: 'Укажите положительную сумму (целое число).' });
        }

        let additionalPhone: any = null;
        const additionalRaw = String(req.body?.additional_phone || '').trim();
        if (additionalRaw) {
          if (!looksLikePhone(additionalRaw)) {
            return res.status(400).json({ message: 'Неверный дополнительный номер телефона.' });
          }
          additionalPhone = normalizePhone(additionalRaw);
        }

        const firmPhoneRaw = String(req.body?.firm_phone || '').trim();
        let clientPhone: any = null;
        if (firmPhoneRaw) {
          if (!looksLikePhone(firmPhoneRaw)) {
            return res.status(400).json({ message: 'Укажите корректный телефон клиента.' });
          }
          clientPhone = normalizePhone(firmPhoneRaw);
        }

        const clientName = req.body?.client_name != null ? String(req.body.client_name).trim() : '';
        const clientType = req.body?.client_type != null ? String(req.body.client_type).trim() : '';
        const firmMessage = req.body?.firm_message != null ? String(req.body.firm_message).trim() : '';
        const recordIdRaw = req.body?.record_id;
        const recordId = recordIdRaw == null || recordIdRaw === '' ? null : recordIdRaw;
        const metadata = JSON.stringify({
          type: clientType || null,
          message: firmMessage || '',
          recordId,
          clientName: clientName || null,
          source: 'bot-admin-firms',
        });

        const { order, paymentUrl, paymentPageUrl } = createOrderFromContext(
          db,
          botUser,
          {
            clientPhone,
            clientType: clientType || null,
            amount,
            metadata,
          },
          additionalPhone
        );

        await notifyServiceOrderCreated(db, botUser, order, paymentPageUrl, paymentUrl);
        auditAdminChange(db, req, {
          entityType: 'order',
          entityId: order!.id,
          action: 'create',
          summary: `Создан заказ ${order!.id} на ${amount} сум`,
          details: buildAuditDetails({
            before: null,
            after: snapshotOrderForAudit(order),
          }),
        });

        return res.status(201).json({
          order,
          payment_page_url: paymentPageUrl,
        });
      } catch (error: any) {
        console.error('Create firm service order error:', error);
        return res.status(500).json({ message: 'Не удалось создать заказ.' });
      }
    }
  );

  router.get('/api/firm-support-prices', requireRight(db, 'create_technical_support'), (_req: Request, res: Response) => {
    const prices = listTechnicalSupportPrices(db)
      .filter((item: any) => item.configured)
      .map((item: any) => ({
        months: item.months,
        amount: item.amount,
        label: `${durationLabel(item.months)} — ${formatAmount(item.amount)}`,
      }));
    return res.json({
      prices,
      message: prices.length ? null : NO_PRICES_TEXT,
    });
  });

  router.post(
    '/api/firm-support-orders',
    requireRight(db, 'create_technical_support'),
    express.json(),
    async (req: Request, res: Response) => {
      try {
        const botUser = resolveSessionBotUser(db, req);
        if (!botUser || botUser.telegram_id == null) {
          return res.status(403).json({ message: ORDER_EMPLOYEE_REQUIRED });
        }

        const phoneRaw = String(req.body?.phone || '').trim();
        if (!phoneRaw || !looksLikePhone(phoneRaw)) {
          return res.status(400).json({ message: NO_PHONE_TEXT });
        }

        const clientName = req.body?.client_name != null ? String(req.body.client_name).trim() : '';
        const clientType = req.body?.client_type != null ? String(req.body.client_type).trim() : '';
        const firmMessage = req.body?.firm_message != null ? String(req.body.firm_message).trim() : '';
        const recordIdRaw = req.body?.record_id;
        const draft = {
          clientPhone: normalizePhone(phoneRaw),
          clientType: clientType || null,
          metadataBase: {
            type: clientType || null,
            message: firmMessage || '',
            recordId: recordIdRaw == null || recordIdRaw === '' ? null : recordIdRaw,
            clientName: clientName || null,
          },
        };

        const outboundBot = getOutboundBot();
        const created = await completeTechnicalSupportPurchase(
          outboundBot,
          db,
          botUser,
          draft,
          req.body?.months
        );
        if (!created) {
          return res.status(400).json({ message: DURATION_UNAVAILABLE_TEXT });
        }

        if (outboundBot) {
          try {
            await outboundBot.sendMessage(
              botUser.telegram_id,
              formatSupportOrderPaymentMessage(
                created.order,
                created.paymentPageUrl,
                created.paymentUrl,
                created.months
              ),
              withHtml()
            );
          } catch (err: any) {
            console.warn('[bot-admin] Creator notify failed:', err.message);
          }
        }

        auditAdminChange(db, req, {
          entityType: 'order',
          entityId: created.order!.id,
          action: 'create',
          summary: `Создан заказ техподдержки ${created.order!.id} на ${created.months} мес.`,
          details: buildAuditDetails({
            before: null,
            after: snapshotOrderForAudit(created.order),
          }),
        });

        return res.status(201).json({
          order: created.order,
          payment_page_url: created.paymentPageUrl,
        });
      } catch (error: any) {
        console.error('Create firm support order error:', error);
        return res.status(500).json({ message: 'Не удалось создать заказ техподдержки.' });
      }
    }
  );

  router.post(
    '/api/firm-tariff',
    requireAnyRight(db, FIRM_SEARCH_RIGHTS),
    express.json(),
    async (req: Request, res: Response) => {
      const accountId = String(req.body?.accountId || '').trim();
      if (!accountId) {
        return res.status(400).json({ message: 'Нет данных о тарифе.' });
      }
      try {
        const message = await buildTariffInfoReply({
          accountId,
          accountLabel: req.body?.accountLabel || null,
          apiLogin: req.body?.apiLogin || null,
          tariff: req.body?.tariff || null,
        });
        return res.json({ message });
      } catch (error: any) {
        console.error('Firm tariff info error:', error);
        return res.status(502).json({ message: TARIFF_LOAD_FAILED });
      }
    }
  );

}
