const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseRegosPricePage,
  calculateTariffMonthlyTotal,
  extraUnits,
} = require('../src/sync/regos-price-page');

const SAMPLE_PRICE_HTML = `
<table class="price-matrix">
  <thead>
    <tr>
      <th></th>
      <th>
        <strong>Start</strong>
        <span class="price-matrix__amount">69 000</span>
        <span class="price-matrix__currency">сум/мес</span>
        <span class="price-matrix__note">при оплате за месяц</span>
      </th>
      <th>
        <strong>Basic</strong>
        <span class="price-matrix__amount">149 000</span>
        <span class="price-matrix__currency">сум/мес</span>
        <span class="price-matrix__note">при оплате за месяц</span>
      </th>
      <th>
        <strong>Plus</strong>
        <span class="price-matrix__amount">254 600</span>
        <span class="price-matrix__currency">сум/мес</span>
        <span class="price-matrix__note">при оплате за год</span>
        <span class="price-matrix__amount">299 000</span>
        <span class="price-matrix__currency">сум/мес</span>
        <span class="price-matrix__note">при оплате за месяц</span>
      </th>
      <th>
        <strong>Pro</strong>
        <span class="price-matrix__amount">687 200</span>
        <span class="price-matrix__currency">сум/мес</span>
        <span class="price-matrix__note">при оплате за год</span>
        <span class="price-matrix__amount">859 000</span>
        <span class="price-matrix__currency">сум/мес</span>
        <span class="price-matrix__note">при оплате за месяц</span>
      </th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th>Количество предприятий</th>
      <td>1</td><td>1</td><td>1</td><td>1</td>
    </tr>
    <tr>
      <th>Количество складов</th>
      <td>1</td><td>1</td><td>1</td><td>5</td>
    </tr>
    <tr>
      <th>Количество касс</th>
      <td>1</td><td>1</td><td>1</td><td>5</td>
    </tr>
    <tr>
      <th>Количество пользователей</th>
      <td>2</td><td>3</td><td>10</td><td>15</td>
    </tr>
    <tr>
      <th>Место на диске под файлы</th>
      <td>50 мб</td><td>512 мб</td><td>1024 мб</td><td>2048 мб</td>
    </tr>
    <tr>
      <th>Период отображения данных</th>
      <td>6 мес</td><td>6 мес</td><td>12 мес</td><td>24 мес</td>
    </tr>
  </tbody>
</table>
<table class="price-table">
  <thead>
    <tr>
      <th class="price-table__name">Наименование</th>
      <th>Стоимость подключения</th>
      <th>Стоимость за период</th>
    </tr>
  </thead>
  <tbody>
    <tr class="price-table__category"><th colspan="3">Тарифные услуги</th></tr>
    <tr>
      <td class="price-table__name">Доп. предприятие</td>
      <td>Бесплатно</td>
      <td>60 000 сум/мес</td>
    </tr>
    <tr>
      <td class="price-table__name">Доп. склад</td>
      <td>Бесплатно</td>
      <td>30 000 сум/мес</td>
    </tr>
    <tr>
      <td class="price-table__name">Доп. касса</td>
      <td>Бесплатно</td>
      <td>30 000 сум/мес</td>
    </tr>
    <tr>
      <td class="price-table__name">Доп. пользователь</td>
      <td>Бесплатно</td>
      <td>25 000 сум/мес</td>
    </tr>
    <tr>
      <td class="price-table__name">Доп. место на диске (+512 Мб)</td>
      <td>Бесплатно</td>
      <td>65 000 сум/мес</td>
    </tr>
    <tr>
      <td class="price-table__name">Доп. период отображения данных (+ 6 мес.)</td>
      <td>Бесплатно</td>
      <td>32 500 сум/мес</td>
    </tr>
  </tbody>
</table>
`;

describe('parseRegosPricePage', () => {
  it('parses monthly plan prices, included limits and extras', () => {
    const catalog = parseRegosPricePage(SAMPLE_PRICE_HTML);
    assert.equal(catalog.plans.Basic.monthlyPrice, 149000);
    assert.equal(catalog.plans.Plus.monthlyPrice, 299000);
    assert.equal(catalog.plans.Plus.yearlyMonthlyPrice, 254600);
    assert.equal(catalog.plans.Pro.monthlyPrice, 859000);
    assert.equal(catalog.plans.Basic.included.users, 3);
    assert.equal(catalog.plans.Basic.included.diskMb, 512);
    assert.equal(catalog.extras.cashRegisters.periodPrice, 30000);
    assert.equal(catalog.extras.diskMb.unitSize, 512);
  });
});

describe('calculateTariffMonthlyTotal', () => {
  it('adds extra cash register over included Basic limit', () => {
    const catalog = parseRegosPricePage(SAMPLE_PRICE_HTML);
    const calc = calculateTariffMonthlyTotal(
      {
        tariffName: 'Basic',
        limits: [
          { key: 'enterprises', total: 1, included: 1 },
          { key: 'warehouses', total: 1, included: 1 },
          { key: 'cashRegisters', total: 2, included: 1 },
          { key: 'users', total: 3, included: 3 },
          { key: 'diskMb', total: 512, included: 512 },
          { key: 'dataMonths', total: 6, included: 6 },
        ],
      },
      catalog
    );
    assert.equal(calc.ok, true);
    assert.equal(calc.base, 149000);
    assert.equal(calc.extrasTotal, 30000);
    assert.equal(calc.total, 179000);
  });

  it('charges disk extras in 512 MB units', () => {
    assert.equal(extraUnits(1536, 512, 512), 2);
    const catalog = parseRegosPricePage(SAMPLE_PRICE_HTML);
    const calc = calculateTariffMonthlyTotal(
      {
        tariffName: 'Basic',
        limits: [{ key: 'diskMb', total: 1536, included: 512 }],
      },
      catalog
    );
    assert.equal(calc.total, 149000 + 2 * 65000);
  });
});
