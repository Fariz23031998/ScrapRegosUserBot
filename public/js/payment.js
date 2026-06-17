const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('status-text');
const orderInfoEl = document.getElementById('order-info');
const paymentsSectionEl = document.getElementById('payments');
const paymentButtonsEl = document.getElementById('payment-buttons');

let paymeStatusTimer = null;

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

function formatAmount(amount, currency = 'UZS') {
  const value = Number(amount);
  if (!Number.isFinite(value)) {
    return `${amount} ${currency}`;
  }
  return `${value.toLocaleString('ru-RU')} ${currency}`;
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

function statusBadgeClass(status) {
  return status === 'paid' ? 'status-badge--paid' : 'status-badge--pending';
}

function setStatus(message, type = 'default') {
  statusTextEl.textContent = message;
  statusEl.classList.remove('status--loading', 'status--success', 'status--error');
  if (type === 'loading') {
    statusEl.classList.add('status--loading');
  } else if (type === 'success') {
    statusEl.classList.add('status--success');
  } else if (type === 'error') {
    statusEl.classList.add('status--error');
  }
}

function renderOrderInfo(order) {
  orderInfoEl.innerHTML = [
    `<div class="order-row order-row--amount">
      <span class="order-row__label">К оплате</span>
      <span class="order-row__value">${formatAmount(order.amount, order.currency || 'UZS')}</span>
    </div>`,
    `<div class="order-row">
      <span class="order-row__label">Клиент</span>
      <span class="order-row__value">${order.client_phone || '—'}</span>
    </div>`,
    `<div class="order-row">
      <span class="order-row__label">Статус</span>
      <span class="order-row__value">
        <span class="status-badge ${statusBadgeClass(order.status)}">${formatStatusText(order.status)}</span>
      </span>
    </div>`,
    `<div class="order-row">
      <span class="order-row__label">ID заказа</span>
      <span class="order-row__value">${order.id}</span>
    </div>`,
  ].join('');
  orderInfoEl.classList.remove('hidden');
}

function renderPaymentButtons(payments) {
  const paymeOnly = payments.filter((payment) => payment.provider === 'payme');
  paymentButtonsEl.innerHTML = '';

  if (!paymeOnly.length) {
    setStatus('Оплата через Payme временно недоступна.', 'error');
    return;
  }

  for (const payment of paymeOnly) {
    const button = document.createElement('a');
    const isPayme = payment.provider === 'payme';
    button.className = `payment-button${isPayme ? ' payment-button--payme' : ''}${
      payment.enabled ? '' : ' disabled'
    }`;
    button.href = payment.enabled ? payment.url : '#';
    button.target = '_blank';
    button.rel = 'noopener noreferrer';

    if (isPayme) {
      button.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="2" y="5" width="20" height="14" rx="3" stroke="currentColor" stroke-width="1.5"/>
          <path d="M2 10h20" stroke="currentColor" stroke-width="1.5"/>
        </svg>
        Оплатить через Payme
      `;
    } else {
      button.textContent = payment.label;
    }

    if (!payment.enabled) {
      button.addEventListener('click', (event) => event.preventDefault());
    }

    paymentButtonsEl.appendChild(button);
  }

  paymentsSectionEl.classList.remove('hidden');
}

async function checkPaymeStatus(orderId) {
  const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/payme/check`, {
    method: 'POST',
  });
  if (!response.ok) {
    return null;
  }
  return response.json();
}

function startPaymeStatusPolling(orderId) {
  if (paymeStatusTimer) {
    clearInterval(paymeStatusTimer);
  }

  const poll = async () => {
    try {
      const result = await checkPaymeStatus(orderId);
      if (!result || result.status !== 'paid') {
        return;
      }

      clearInterval(paymeStatusTimer);
      paymeStatusTimer = null;

      const orderResponse = await fetch(`/api/orders/${encodeURIComponent(orderId)}/payments`);
      if (orderResponse.ok) {
        const data = await orderResponse.json();
        renderOrderInfo(data.order);
      }

      setStatus('Оплата прошла успешно. Спасибо!', 'success');
      paymentsSectionEl.classList.add('hidden');
    } catch {
      // Ignore polling errors; user can refresh manually.
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      poll();
    }
  });

  paymeStatusTimer = setInterval(poll, 5000);
}

async function loadPaymentData() {
  const orderId = getOrderIdFromLocation();
  if (!orderId) {
    setStatus('Не указан ID заказа.', 'error');
    return;
  }

  setStatus('Загрузка данных...', 'loading');

  try {
    const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/payments`);
    const data = await response.json();

    if (!response.ok) {
      setStatus(data.message || 'Заказ не найден.', 'error');
      return;
    }

    renderOrderInfo(data.order);

    if (data.order.status === 'paid') {
      setStatus('Этот заказ уже оплачен.', 'success');
      return;
    }

    if (data.order.status !== 'pending') {
      setStatus(`Заказ в статусе: ${formatStatusText(data.order.status)}`, 'error');
      return;
    }

    setStatus('Нажмите кнопку ниже для перехода к оплате');
    renderPaymentButtons(data.payments || []);

    if ((data.payments || []).some((payment) => payment.provider === 'payme')) {
      startPaymeStatusPolling(orderId);
    }
  } catch {
    setStatus('Не удалось загрузить данные оплаты.', 'error');
  }
}

loadPaymentData();
