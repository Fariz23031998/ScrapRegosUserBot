import type { Unchecked } from '../types/unchecked';
import { formatPaymentPageUrl } from '../payments/payments-api';
import { formatOrderPartyLines } from './order-parties';
import { formatOrderDateTimeLine, formatOrderDateTimeValue } from './order-datetime';
import { formatOrderTicketLine } from './order-ticket';
import { bold, field, link } from './telegram-html';

function formatUnpaidOrderLines(order: any, { includeClientPhone = false }: Unchecked = {}) {
  const paymentPageUrl = formatPaymentPageUrl(order.id);
  const lines = [field('🆔', 'ID', order.id), ...formatOrderPartyLines(order)];
  const dateLine = formatOrderDateTimeLine(order);
  if (dateLine) lines.push(dateLine);
  const ticketLine = formatOrderTicketLine(order);
  if (ticketLine) lines.push(ticketLine);
  lines.push(
    field('💳', 'Сумма', `${order.amount} ${order.currency || 'UZS'}`),
    field('📌', 'Статус', order.status)
  );
  if (paymentPageUrl) {
    lines.push(`🔗 ${link(paymentPageUrl, 'Страница оплаты')}`);
  }
  return lines;
}

function formatUnpaidOrderMessage(order: any, { includeClientPhone = false }: Unchecked = {}) {
  return formatUnpaidOrderLines(order, { includeClientPhone }).join('\n');
}

function formatUnpaidOrdersBlock(orders: any, { includeClientPhone = false }: Unchecked = {}) {
  if (!orders.length) return '';

  const header =
    orders.length === 1
      ? `⚠️ ${bold('Есть неоплаченный заказ:')}`
      : `⚠️ ${bold(`Есть неоплаченные заказы (${orders.length}):`)}`;

  const blocks = orders.map((order?: any, index?: any) => {
    const lines = formatUnpaidOrderLines(order, { includeClientPhone });
    const body =
      orders.length === 1
        ? lines.join('\n')
        : [`📦 ${bold(`Заказ ${index + 1}:`)}`, ...lines].join('\n');
    return body;
  });

  return `${header}\n\n${blocks.join('\n\n')}`;
}

function buildOrderActionsKeyboard(
  orderId: any,
  { canDelete = false, canMarkPaidCash = false, canRenotify = false }: Unchecked = {}
) {
  const row: any[] = [];
  if (canDelete) {
    row.push({ text: 'Удалить', callback_data: `order:delete:${orderId}` });
  }
  if (canMarkPaidCash) {
    row.push({ text: 'Оплачено наличными', callback_data: `order:paid_cash:${orderId}` });
  }
  if (canRenotify) {
    row.push({ text: 'Повторно уведомить', callback_data: `order:renotify:${orderId}` });
  }
  if (!row.length) return undefined;
  return { reply_markup: { inline_keyboard: [row] } };
}

export {
  formatOrderDateTimeValue,
  formatOrderDateTimeLine,
  formatUnpaidOrderLines,
  formatUnpaidOrderMessage,
  formatUnpaidOrdersBlock,
  buildOrderActionsKeyboard,
};
