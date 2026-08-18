const { getSetting, setSetting } = require('./app-settings');

const CURRENCIES = ['UZS', 'USD'];
const DEFAULT_USD_UZS_RATE = 12500;

function roundMoney(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10000) / 10000;
}

function getUsdUzsRate(db) {
  const raw = getSetting(db, 'usd_uzs_rate', String(DEFAULT_USD_UZS_RATE));
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate <= 0) return DEFAULT_USD_UZS_RATE;
  return rate;
}

function setUsdUzsRate(db, value) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('INVALID_EXCHANGE_RATE');
  setSetting(db, 'usd_uzs_rate', String(rate));
  return rate;
}

function parseNonNegativeAmount(value, { allowNull = false } = {}) {
  if (value == null || value === '') {
    if (allowNull) return null;
    throw new Error('INVALID_MONEY_AMOUNT');
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('INVALID_MONEY_AMOUNT');
  return amount;
}

function normalizeCostInput(input = {}) {
  const cost_amount = parseNonNegativeAmount(input.cost_amount ?? 0);
  const cost_currency = String(input.cost_currency || 'UZS').trim().toUpperCase();
  if (!CURRENCIES.includes(cost_currency)) throw new Error('INVALID_COST_CURRENCY');
  return { cost_amount, cost_currency };
}

function normalizePriceInput(input = {}) {
  const price_uzs = parseNonNegativeAmount(input.price_uzs, { allowNull: true });
  const price_usd = parseNonNegativeAmount(input.price_usd, { allowNull: true });
  if (price_uzs == null && price_usd == null) throw new Error('INVALID_PRICE');
  return { price_uzs, price_usd };
}

function normalizeMoneyInput(input = {}) {
  return {
    ...normalizeCostInput(input),
    ...normalizePriceInput(input),
  };
}

function convertCost(amount, currency, rate) {
  const n = Number(amount) || 0;
  const safeRate = Number(rate) > 0 ? Number(rate) : DEFAULT_USD_UZS_RATE;
  if (currency === 'USD') {
    return { cost_uzs: roundMoney(n * safeRate), cost_usd: roundMoney(n) };
  }
  return { cost_uzs: roundMoney(n), cost_usd: roundMoney(n / safeRate) };
}

function convertPrice(priceUzs, priceUsd, rate) {
  const safeRate = Number(rate) > 0 ? Number(rate) : DEFAULT_USD_UZS_RATE;
  const storedUzs = priceUzs == null || priceUzs === '' ? null : Number(priceUzs);
  const storedUsd = priceUsd == null || priceUsd === '' ? null : Number(priceUsd);
  let uzs = Number.isFinite(storedUzs) ? storedUzs : null;
  let usd = Number.isFinite(storedUsd) ? storedUsd : null;
  if (uzs == null && usd != null) uzs = usd * safeRate;
  if (usd == null && uzs != null) usd = uzs / safeRate;
  return {
    price_uzs: roundMoney(uzs || 0),
    price_usd: roundMoney(usd || 0),
  };
}

function storedAmount(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function presentMoneyFields(row, rate) {
  const cost_amount = Number(row?.cost_amount) || 0;
  const cost_currency = row?.cost_currency === 'USD' ? 'USD' : 'UZS';
  const price_uzs = storedAmount(row?.price_uzs);
  const price_usd = storedAmount(row?.price_usd);
  const cost = convertCost(cost_amount, cost_currency, rate);
  const price = convertPrice(price_uzs, price_usd, rate);
  return {
    cost_amount,
    cost_currency,
    cost_uzs: cost.cost_uzs,
    cost_usd: cost.cost_usd,
    price_uzs,
    price_usd,
    display_price_uzs: price.price_uzs,
    display_price_usd: price.price_usd,
  };
}

function snapshotMoney(item) {
  return {
    cost_amount: Number(item?.cost_amount) || 0,
    cost_currency: item?.cost_currency === 'USD' ? 'USD' : 'UZS',
    price_uzs: storedAmount(item?.price_uzs),
    price_usd: storedAmount(item?.price_usd),
  };
}

function lineQuantity(line) {
  const qty = Number(line?.quantity);
  if (!Number.isFinite(qty) || qty < 1) return 1;
  return qty;
}

function emptyDiscount() {
  return { discount_type: null, discount_value: 0, discount_currency: null };
}

function normalizeDiscountInput(input = {}, { allowEmpty = true } = {}) {
  const rawType = input.discount_type == null ? input.type : input.discount_type;
  if (rawType == null || rawType === '' || rawType === 'none') {
    if (!allowEmpty) throw new Error('INVALID_TASK_DISCOUNT');
    return emptyDiscount();
  }
  const type = String(rawType).trim();
  if (type !== 'percent' && type !== 'amount') throw new Error('INVALID_TASK_DISCOUNT');
  const rawValue = input.discount_value == null ? input.value : input.discount_value;
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) throw new Error('INVALID_TASK_DISCOUNT');
  if (type === 'percent') {
    if (value > 100) throw new Error('INVALID_TASK_DISCOUNT');
    return { discount_type: 'percent', discount_value: roundMoney(value), discount_currency: null };
  }
  const rawCurrency = input.discount_currency == null ? input.currency : input.discount_currency;
  const currency = String(rawCurrency || 'UZS').trim().toUpperCase();
  if (!CURRENCIES.includes(currency)) throw new Error('INVALID_TASK_DISCOUNT');
  return { discount_type: 'amount', discount_value: roundMoney(value), discount_currency: currency };
}

function readDiscount(line) {
  const type = line?.discount_type == null || line.discount_type === '' ? null : String(line.discount_type);
  if (type !== 'percent' && type !== 'amount') return emptyDiscount();
  const value = Number(line.discount_value);
  if (!Number.isFinite(value) || value <= 0) return emptyDiscount();
  if (type === 'percent') {
    return { discount_type: 'percent', discount_value: Math.min(100, value), discount_currency: null };
  }
  return {
    discount_type: 'amount',
    discount_value: value,
    discount_currency: line.discount_currency === 'USD' ? 'USD' : 'UZS',
  };
}

function applyDiscountToLineTotal(withoutDiscount, discount, rate) {
  const safeRate = Number(rate) > 0 ? Number(rate) : DEFAULT_USD_UZS_RATE;
  const source = {
    price_uzs: roundMoney(Number(withoutDiscount?.price_uzs) || 0),
    price_usd: roundMoney(Number(withoutDiscount?.price_usd) || 0),
  };
  const parsed = readDiscount(discount);
  if (!parsed.discount_type || !parsed.discount_value) return source;
  if (parsed.discount_type === 'percent') {
    const factor = Math.max(0, 1 - parsed.discount_value / 100);
    return {
      price_uzs: roundMoney(source.price_uzs * factor),
      price_usd: roundMoney(source.price_usd * factor),
    };
  }
  if (parsed.discount_currency === 'USD') {
    const usd = Math.max(0, source.price_usd - parsed.discount_value);
    return { price_uzs: roundMoney(usd * safeRate), price_usd: roundMoney(usd) };
  }
  const uzs = Math.max(0, source.price_uzs - parsed.discount_value);
  return { price_uzs: roundMoney(uzs), price_usd: roundMoney(uzs / safeRate) };
}

function computeLineRefundAmount(line, refundQty, rate) {
  return computeLineMoney({ ...line, quantity: refundQty }, rate);
}

function computeLineMoney(line, rate) {
  const qty = lineQuantity(line);
  const cost = convertCost(line.cost_amount, line.cost_currency, rate);
  const unit = convertPrice(line.price_uzs, line.price_usd, rate);
  const withoutDiscount = {
    price_uzs: roundMoney(unit.price_uzs * qty),
    price_usd: roundMoney(unit.price_usd * qty),
  };
  const price = applyDiscountToLineTotal(withoutDiscount, line, rate);
  return {
    cost_uzs: roundMoney(cost.cost_uzs * qty),
    cost_usd: roundMoney(cost.cost_usd * qty),
    price_without_discount_uzs: withoutDiscount.price_uzs,
    price_without_discount_usd: withoutDiscount.price_usd,
    price_uzs: price.price_uzs,
    price_usd: price.price_usd,
  };
}

function presentTaskLineMoney(row, rate) {
  const discount = readDiscount(row);
  const computed = computeLineMoney(row, rate);
  return {
    cost_amount: Number(row?.cost_amount) || 0,
    cost_currency: row?.cost_currency === 'USD' ? 'USD' : 'UZS',
    cost_uzs: computed.cost_uzs,
    cost_usd: computed.cost_usd,
    price_stored_uzs: storedAmount(row?.price_uzs),
    price_stored_usd: storedAmount(row?.price_usd),
    price_without_discount_uzs: computed.price_without_discount_uzs,
    price_without_discount_usd: computed.price_without_discount_usd,
    price_uzs: computed.price_uzs,
    price_usd: computed.price_usd,
    display_price_uzs: computed.price_uzs,
    display_price_usd: computed.price_usd,
    discount_type: discount.discount_type,
    discount_value: discount.discount_value,
    discount_currency: discount.discount_currency,
  };
}

function emptyMoneyTotals() {
  return {
    cost_uzs: 0,
    cost_usd: 0,
    price_uzs: 0,
    price_usd: 0,
    price_without_discount_uzs: 0,
    price_without_discount_usd: 0,
  };
}

function sumMoneyTotals(lines, rate) {
  const totals = emptyMoneyTotals();
  for (const line of lines || []) {
    const computed =
      line?.price_without_discount_uzs != null || line?.price_without_discount_usd != null
        ? {
            cost_uzs: Number(line.cost_uzs) || 0,
            cost_usd: Number(line.cost_usd) || 0,
            price_without_discount_uzs: Number(line.price_without_discount_uzs) || 0,
            price_without_discount_usd: Number(line.price_without_discount_usd) || 0,
            price_uzs: Number(line.price_uzs) || 0,
            price_usd: Number(line.price_usd) || 0,
          }
        : computeLineMoney(line, rate);
    totals.cost_uzs += computed.cost_uzs;
    totals.cost_usd += computed.cost_usd;
    totals.price_without_discount_uzs += computed.price_without_discount_uzs;
    totals.price_without_discount_usd += computed.price_without_discount_usd;
    totals.price_uzs += computed.price_uzs;
    totals.price_usd += computed.price_usd;
  }
  return {
    cost_uzs: roundMoney(totals.cost_uzs),
    cost_usd: roundMoney(totals.cost_usd),
    price_uzs: roundMoney(totals.price_uzs),
    price_usd: roundMoney(totals.price_usd),
    price_without_discount_uzs: roundMoney(totals.price_without_discount_uzs),
    price_without_discount_usd: roundMoney(totals.price_without_discount_usd),
  };
}

module.exports = {
  CURRENCIES,
  DEFAULT_USD_UZS_RATE,
  roundMoney,
  getUsdUzsRate,
  setUsdUzsRate,
  normalizeCostInput,
  normalizePriceInput,
  normalizeMoneyInput,
  convertCost,
  convertPrice,
  presentMoneyFields,
  presentTaskLineMoney,
  snapshotMoney,
  normalizeDiscountInput,
  emptyDiscount,
  applyDiscountToLineTotal,
  computeLineMoney,
  computeLineRefundAmount,
  emptyMoneyTotals,
  sumMoneyTotals,
};
