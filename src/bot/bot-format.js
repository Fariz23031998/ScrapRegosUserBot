const { formatPaymentPageUrl } = require('../payments/payments-api');
const { formatOrderPartyLines } = require('./order-parties');
const { formatOrderDateTimeLine, formatOrderDateTimeValue } = require('./order-datetime');

function formatUnpaidOrderLines(order, { includeClientPhone = false } = {}) {
  const paymentPageUrl = formatPaymentPageUrl(order.id);
  const lines = [`ID: ${order.id}`, ...formatOrderPartyLines(order)];
  const dateLine = formatOrderDateTimeLine(order);
  if (dateLine) lines.push(dateLine);
  lines.push(`Сумма: ${order.amount} ${order.currency || 'UZS'}`, `Статус: ${order.status}`);
  if (paymentPageUrl) {
    lines.push(`Страница оплаты: ${paymentPageUrl}`);
  }
  return lines;
}

function formatUnpaidOrderMessage(order, { includeClientPhone = false } = {}) {
  return formatUnpaidOrderLines(order, { includeClientPhone }).join('\n');
}

function formatUnpaidOrdersBlock(orders, { includeClientPhone = false } = {}) {
  if (!orders.length) return '';

  const header =
    orders.length === 1
      ? 'Есть неоплаченный заказ:'
      : `Есть неоплаченные заказы (${orders.length}):`;

  const blocks = orders.map((order, index) => {
    const lines = formatUnpaidOrderLines(order, { includeClientPhone });
    const body = orders.length === 1 ? lines.join('\n') : [`Заказ ${index + 1}:`, ...lines].join('\n');
    return body;
  });

  return `${header}\n\n${blocks.join('\n\n')}`;
}

function buildOrderActionsKeyboard(
  orderId,
  { canDelete = false, canMarkPaidCash = false, canRenotify = false } = {}
) {
  const row = [];
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

module.exports = {
  formatOrderDateTimeValue,
  formatOrderDateTimeLine,
  formatUnpaidOrderLines,
  formatUnpaidOrderMessage,
  formatUnpaidOrdersBlock,
  buildOrderActionsKeyboard,
};
