const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  convertCost,
  convertPrice,
  normalizeCostInput,
  normalizePriceInput,
  normalizeMoneyInput,
  sumMoneyTotals,
  applyDiscountToLineTotal,
  computeLineMoney,
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

  it('multiplies line totals by quantity', () => {
    const totals = sumMoneyTotals(
      [
        { cost_amount: 100, cost_currency: 'USD', price_uzs: null, price_usd: 150, quantity: 2 },
        { cost_amount: 250_000, cost_currency: 'UZS', price_uzs: 300_000, price_usd: null, quantity: 3 },
      ],
      12500
    );
    assert.equal(totals.cost_uzs, 3_250_000);
    assert.equal(totals.cost_usd, 260);
    assert.equal(totals.price_uzs, 4_650_000);
    assert.equal(totals.price_usd, 372);
    assert.equal(totals.price_without_discount_uzs, 4_650_000);
    assert.equal(totals.price_without_discount_usd, 372);
  });

  it('applies percent and amount discounts to line totals', () => {
    const percent = applyDiscountToLineTotal(
      { price_uzs: 1_000_000, price_usd: 80 },
      { discount_type: 'percent', discount_value: 10 },
      12500
    );
    assert.equal(percent.price_uzs, 900_000);
    assert.equal(percent.price_usd, 72);

    const amount = applyDiscountToLineTotal(
      { price_uzs: 300_000, price_usd: 24 },
      { discount_type: 'amount', discount_value: 50_000, discount_currency: 'UZS' },
      12500
    );
    assert.equal(amount.price_uzs, 250_000);
    assert.equal(amount.price_usd, 20);

    const line = computeLineMoney(
      {
        cost_amount: 100,
        cost_currency: 'USD',
        price_usd: 150,
        quantity: 2,
        discount_type: 'percent',
        discount_value: 10,
      },
      12500
    );
    assert.equal(line.price_without_discount_usd, 300);
    assert.equal(line.price_usd, 270);
    assert.equal(line.price_without_discount_uzs, 3_750_000);
    assert.equal(line.price_uzs, 3_375_000);
  });
});
