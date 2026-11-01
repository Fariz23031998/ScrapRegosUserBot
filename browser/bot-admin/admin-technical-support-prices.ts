declare var state: any, DURATIONS: any;
function durationLabel(months: any) {
  const value = Number(months);
  if (value === 1) return '1 месяц';
  if (value === 3) return '3 месяца';
  if (value === 6) return '6 месяцев';
  if (value === 12) return '12 месяцев';
  return 'custom';
}

function formatAmount(value: any) {
  return Number(value || 0).toLocaleString('ru-RU');
}

function formatDateTime(value: any) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return `${escapeHtml(date.toLocaleDateString('ru-RU'))}<span class="cell-sub">${escapeHtml(
    date.toLocaleTimeString('ru-RU')
  )}</span>`;
}

function formatPhone(value: any) {
  const digits = String(value || '').replace(/\D/g, '');
  const match = /^998(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(digits);
  if (!match) return escapeHtml(value || '—');
  const [, code, first, second, third] = match;
  return escapeHtml(`+998 ${code} ${first}-${second}-${third}`);
}

function toDateInputValue(value: any) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: any) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addLocalMonths(date: any, months: any) {
  const result = new Date(date.getTime());
  const day = result.getDate();
  result.setMonth(result.getMonth() + Number(months));
  if (result.getDate() < day) {
    result.setDate(0);
  }
  return result;
}

function suggestedEndsAtFromMonths(months: any) {
  return toDateInputValue(addLocalMonths(new Date(), months));
}

/** Convert YYYY-MM-DD to ISO at end of that local day. */
function fromDateInputValue(value: any) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 23, 59, 59, 999);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date.toISOString();
}

function showPricesMessage(text: any, isError: any = false) {
  const el = (document.getElementById('prices-message') as any);
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = text;
  el.className = `message ${isError ? 'error' : 'success'}`;
}

function showModalError(id: any, text: any) {
  const el = (document.getElementById(id) as any);
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = text;
}

function setModalOpen(overlay: any, open: any) {
  overlay.hidden = !open;
  document.documentElement.classList.toggle('modal-open', open);
  document.body.classList.toggle('modal-open', open);
}

function isCustomDuration() {
  return (document.getElementById('create-months') as any).value === 'custom';
}

function catalogAmountForMonths(months: any) {
  return Number(state.pricesByMonths[String(months)] || 0);
}

function syncCreateDurationFields() {
  const custom = isCustomDuration();
  const amountInput = (document.getElementById('create-amount') as any);
  const endsInput = (document.getElementById('create-ends-at') as any);
  amountInput.disabled = !custom;
  endsInput.disabled = !custom;
  endsInput.required = custom;
  if (!custom) {
    const months = Number((document.getElementById('create-months') as any).value);
    if (DURATIONS.includes(months)) {
      endsInput.value = suggestedEndsAtFromMonths(months);
      amountInput.value = String(catalogAmountForMonths(months));
    }
  }
}

function closeCreateModal() {
  setModalOpen((document.getElementById('create-subscription-modal') as any), false);
  showModalError('create-subscription-error', '');
}

function closeEditModal() {
  setModalOpen((document.getElementById('edit-subscription-modal') as any), false);
  showModalError('edit-subscription-error', '');
}

function openCreateModal() {
  const form = (document.getElementById('create-subscription-form') as any);
  form.reset();
  (document.getElementById('create-months') as any).value = '3';
  (document.getElementById('create-amount') as any).value = String(catalogAmountForMonths(3));
  (document.getElementById('create-ends-at') as any).value = suggestedEndsAtFromMonths(3);
  syncCreateDurationFields();
  showModalError('create-subscription-error', '');
  setModalOpen((document.getElementById('create-subscription-modal') as any), true);
  (document.getElementById('create-phone') as any).focus();
}

function openEditModal(row: any) {
  (document.getElementById('edit-subscription-id') as any).value = String(row.id);
  (document.getElementById('edit-subscription-meta') as any).textContent =
    `${row.phone || ''} · ${durationLabel(row.months)}`;
  (document.getElementById('edit-ends-at') as any).value = toDateInputValue(row.ends_at);
  showModalError('edit-subscription-error', '');
  setModalOpen((document.getElementById('edit-subscription-modal') as any), true);
  (document.getElementById('edit-ends-at') as any).focus();
}

function renderPricesForm(prices: any, { canEdit = true }: any = {}) {
  const grid = (document.getElementById('prices-grid') as any);
  const byMonths = new Map<number, any>((prices || []).map((row: any) => [Number(row.months), row]));
  state.pricesByMonths = {};
  for (const months of DURATIONS) {
    const row = byMonths.get(months) || { amount: 0 };
    state.pricesByMonths[String(months)] = Number(row.amount || 0);
  }
  grid.innerHTML = DURATIONS.map((months: any) => {
    const row = byMonths.get(months) || { amount: 0, configured: false };
    const hint = row.configured
      ? 'Настроено'
      : 'Не настроено (кнопка в боте будет скрыта)';
    return `
      <label class="field">
        <span>${durationLabel(months)}</span>
        <input
          type="number"
          min="0"
          step="1"
          name="price_${months}"
          data-months="${months}"
          value="${Number(row.amount || 0)}"
          required
          ${canEdit ? '' : 'readonly disabled'}
        />
        <small class="field-hint ${row.configured ? 'field-hint--ok' : 'field-hint--warn'}">${hint}</small>
      </label>
    `;
  }).join('');
}

async function loadPrices(canEdit: any = true) {
  const grid = (document.getElementById('prices-grid') as any);
  grid.innerHTML = renderLoadingState();
  const data = await api('/bot-admin/api/technical-support/prices');
  renderPricesForm(data.prices || [], { canEdit });
}

async function savePrices(event: any) {
  event.preventDefault();
  showPricesMessage('');
  const prices: any = {};
  for (const input of document.querySelectorAll('#prices-grid input[data-months]') as any) {
    const months = input.getAttribute('data-months');
    const amount = Number(input.value);
    if (!Number.isInteger(amount) || amount < 0) {
      showPricesMessage('Сумма должна быть целым числом ≥ 0.', true);
      return;
    }
    prices[months!] = amount;
  }

  const submitBtn = (document.getElementById('prices-submit') as any);
  setButtonLoading(submitBtn, true);
  try {
    const data = await api('/bot-admin/api/technical-support/prices', {
      method: 'PUT',
      body: JSON.stringify({ prices }),
    });
    renderPricesForm(data.prices || []);
    showPricesMessage('Цены сохранены.');
  } catch (error: any) {
    showPricesMessage(error.message || 'Не удалось сохранить цены.', true);
  } finally {
    setButtonLoading(submitBtn, false);
  }
}
