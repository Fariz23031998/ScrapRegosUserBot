const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  convertCost,
  convertPrice,
  normalizeCostInput,
  normalizePriceInput,
  normalizeMoneyInput,
  sumMoneyTotals,
} = require('../src/db/money');

describe('money helpers', () => {
  it('converts cost from USD using 1 USD = X UZS', () => {
    assert.deepEqual(convertCost(100, 'USD', 12500), { cost_uzs: 1_250_000, cost_usd: 100 });
  });

  it('converts cost from UZS using 1 USD = X UZS', () => {
    assert.deepEqual(convertCost(1_250_000, 'UZS', 12500), { cost_uzs: 1_250_000, cost_usd: 100 });
  });

  it('fills the missing price side and keeps stored values', () => {
    assert.deepEqual(convertPrice(1_250_000, null, 12500), { price_uzs: 1_250_000, price_usd: 100 });
    assert.deepEqual(convertPrice(null, 80, 12500), { price_uzs: 1_000_000, price_usd: 80 });
    assert.deepEqual(convertPrice(1_200_000, 100, 12500), { price_uzs: 1_200_000, price_usd: 100 });
  });

  it('requires a non-negative cost and at least one price', () => {
    assert.deepEqual(normalizeCostInput({ cost_amount: 0, cost_currency: 'uzs' }), {
      cost_amount: 0,
      cost_currency: 'UZS',
    });
    assert.throws(() => normalizeCostInput({ cost_amount: -1, cost_currency: 'UZS' }), /INVALID_MONEY_AMOUNT/);
    assert.throws(() => normalizePriceInput({}), /INVALID_PRICE/);
    assert.deepEqual(normalizeMoneyInput({ cost_amount: 10, cost_currency: 'USD', price_usd: 12 }), {
      cost_amount: 10,
      cost_currency: 'USD',
      price_uzs: null,
      price_usd: 12,
    });
  });

  it('sums snapshotted lines with the current rate', () => {
    const totals = sumMoneyTotals(
      [
        { cost_amount: 100, cost_currency: 'USD', price_uzs: null, price_usd: 150 },
        { cost_amount: 250_000, cost_currency: 'UZS', price_uzs: 300_000, price_usd: null },
      ],
      12500
    );
    assert.equal(totals.cost_uzs, 1_500_000);
    assert.equal(totals.cost_usd, 120);
    assert.equal(totals.price_uzs, 2_175_000);
    assert.equal(totals.price_usd, 174);
  });
});
