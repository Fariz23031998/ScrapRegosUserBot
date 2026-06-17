const { formatPaymentPageUrl } = require('./payments-api');

function formatUnpaidOrderLines(order) {
  const paymentPageUrl = formatPaymentPageUrl(order.id);
  const lines = [
    `ID: ${order.id}`,
    `Сумма: ${order.amount} ${order.currency || 'UZS'}`,
    `Статус: ${order.status}`,
  ];
  if (paymentPageUrl) {
    lines.push(`Страница оплаты: ${paymentPageUrl}`);
  }
  return lines;
}

function formatUnpaidOrdersBlock(orders, { showDelete = false } = {}) {
  if (!orders.length) return '';

  const header =
    orders.length === 1
      ? 'Есть неоплаченный заказ:'
      : `Есть неоплаченные заказы (${orders.length}):`;

  const blocks = orders.map((order, index) => {
    const lines = formatUnpaidOrderLines(order);
    const body = orders.length === 1 ? lines.join('\n') : [`Заказ ${index + 1}:`, ...lines].join('\n');
    return body;
  });

  return `${header}\n\n${blocks.join('\n\n')}`;
}

function buildDeleteKeyboard(orderId) {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: 'Удалить', callback_data: `order:delete:${orderId}` }]],
    },
  };
}

module.exports = {
  formatUnpaidOrderLines,
  formatUnpaidOrdersBlock,
  buildDeleteKeyboard,
};
