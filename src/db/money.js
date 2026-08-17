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

function sumMoneyTotals(lines, rate) {
  const totals = { cost_uzs: 0, cost_usd: 0, price_uzs: 0, price_usd: 0 };
  for (const line of lines || []) {
    const cost = convertCost(line.cost_amount, line.cost_currency, rate);
    const price = convertPrice(line.price_uzs, line.price_usd, rate);
    totals.cost_uzs += cost.cost_uzs;
    totals.cost_usd += cost.cost_usd;
    totals.price_uzs += price.price_uzs;
    totals.price_usd += price.price_usd;
  }
  return {
    cost_uzs: roundMoney(totals.cost_uzs),
    cost_usd: roundMoney(totals.cost_usd),
    price_uzs: roundMoney(totals.price_uzs),
    price_usd: roundMoney(totals.price_usd),
  };
}

module.exports = {
  CURRENCIES,
  DEFAULT_USD_UZS_RATE,
  getUsdUzsRate,
  setUsdUzsRate,
  normalizeCostInput,
  normalizePriceInput,
  normalizeMoneyInput,
  convertCost,
  convertPrice,
  presentMoneyFields,
  snapshotMoney,
  sumMoneyTotals,
};
