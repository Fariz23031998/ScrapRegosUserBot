const statusEl = document.getElementById('status');
const orderInfoEl = document.getElementById('order-info');
const paymentsSectionEl = document.getElementById('payments');
const paymentButtonsEl = document.getElementById('payment-buttons');

function getOrderIdFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('order_id')?.trim();
  if (fromQuery) {
    return fromQuery;
  }

  const segments = window.location.pathname.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1] || '';
  return lastSegment;
}

function formatStatusText(status) {
  const map = {
    pending: 'Ожидает оплаты',
    paid: 'Оплачен',
    failed: 'Ошибка оплаты',
    cancelled: 'Отменён',
  };
  return map[status] || status;
}

function renderOrderInfo(order) {
  orderInfoEl.innerHTML = [
    `<div><strong>ID:</strong> ${order.id}</div>`,
    `<div><strong>Клиент:</strong> ${order.client_phone || '-'}</div>`,
    `<div><strong>Сумма:</strong> ${order.amount} ${order.currency || 'UZS'}</div>`,
    `<div><strong>Статус:</strong> ${formatStatusText(order.status)}</div>`,
  ].join('');
  orderInfoEl.classList.remove('hidden');
}

function renderPaymentButtons(payments) {
  paymentButtonsEl.innerHTML = '';

  if (!payments.length) {
    statusEl.textContent = 'Для этого заказа нет доступных способов оплаты.';
    statusEl.classList.add('error');
    return;
  }

  for (const payment of payments) {
    const button = document.createElement('a');
    button.className = `payment-button${payment.enabled ? '' : ' disabled'}`;
    button.textContent = payment.label;
    button.href = payment.enabled ? payment.url : '#';
    button.target = '_blank';
    button.rel = 'noopener noreferrer';

    if (!payment.enabled) {
      button.addEventListener('click', (event) => event.preventDefault());
    }

    paymentButtonsEl.appendChild(button);
  }

  paymentsSectionEl.classList.remove('hidden');
}

async function loadPaymentData() {
  const orderId = getOrderIdFromLocation();
  if (!orderId) {
    statusEl.textContent = 'Не указан ID заказа.';
    statusEl.classList.add('error');
    return;
  }

  try {
    const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/payments`);
    const data = await response.json();

    if (!response.ok) {
      statusEl.textContent = data.message || 'Заказ не найден.';
      statusEl.classList.add('error');
      return;
    }

    renderOrderInfo(data.order);

    if (data.order.status === 'paid') {
      statusEl.textContent = 'Заказ уже оплачен.';
      statusEl.classList.add('success');
      return;
    }

    if (data.order.status !== 'pending') {
      statusEl.textContent = `Заказ в статусе: ${formatStatusText(data.order.status)}`;
      return;
    }

    statusEl.textContent = 'Выберите способ оплаты:';
    renderPaymentButtons(data.payments || []);
  } catch (error) {
    statusEl.textContent = 'Не удалось загрузить данные оплаты.';
    statusEl.classList.add('error');
  }
}

loadPaymentData();
