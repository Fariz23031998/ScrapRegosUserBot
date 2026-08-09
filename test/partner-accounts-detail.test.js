const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parsePartnerAccountOverview } = require('../src/sync/partner-accounts-detail');

const SAMPLE_OVERVIEW_HTML = `
<div class="tab-pane active account-overview">
  <div class="row mb-3">
    <div class="col-md-6 col-xl-3 mb-2">
      <div class="account-kpi">
        <span class="account-kpi-title">&#x421;&#x442;&#x430;&#x442;&#x443;&#x441;</span>
        <div class="account-kpi-value">&#x410;&#x43A;&#x442;&#x438;&#x432;&#x435;&#x43D;</div>
      </div>
    </div>
    <div class="col-md-6 col-xl-3 mb-2">
      <div class="account-kpi">
        <span class="account-kpi-title">&#x418;&#x441;&#x43F;&#x43E;&#x43B;&#x44C;&#x437;&#x443;&#x435;&#x43C;&#x44B;&#x439; &#x43B;&#x438;&#x43C;&#x438;&#x442;</span>
        <div class="account-kpi-value">98.55 / -1</div>
      </div>
    </div>
    <div class="col-md-6 col-xl-3 mb-2">
      <div class="account-kpi">
        <span class="account-kpi-title">&#x421;&#x442;&#x43E;&#x438;&#x43C;&#x43E;&#x441;&#x442;&#x44C; &#x442;&#x430;&#x440;&#x438;&#x444;&#x430;</span>
        <div class="account-kpi-value">149,000 UZS</div>
      </div>
    </div>
  </div>
  <div class="form-group">
    <label><strong>&#x422;&#x430;&#x440;&#x438;&#x444;</strong></label>
    <label class="form-control">Basic</label>
  </div>
  <div class="form-group">
    <label><strong>&#x41B;&#x438;&#x43C;&#x438;&#x442;&#x44B; &#x442;&#x430;&#x440;&#x438;&#x444;&#x430;</strong></label>
    <div class="form-control" style="height:auto; padding: 10px;">
      <div style="padding-bottom: 5px;">
        &#x41A;&#x43E;&#x43B;&#x438;&#x447;&#x435;&#x441;&#x442;&#x432;&#x43E; &#x43F;&#x440;&#x435;&#x434;&#x43F;&#x440;&#x438;&#x44F;&#x442;&#x438;&#x439;:
        <div style="margin-left: 15px; display: flex; gap: 20px;">
          <span> &#x412;&#x441;&#x435;&#x433;&#x43E;: <b>1</b> </span>
          <span class="text-muted"> &#x41F;&#x43E; &#x442;&#x430;&#x440;&#x438;&#x444;&#x443;: 1 </span>
          <span class="text-info"> &#x424;&#x430;&#x43A;&#x442;&#x438;&#x447;&#x435;&#x441;&#x43A;&#x438;: <b>1</b> </span>
        </div>
      </div>
      <div style="padding-bottom: 5px;">
        &#x41A;&#x43E;&#x43B;&#x438;&#x447;&#x435;&#x441;&#x442;&#x432;&#x43E; &#x43A;&#x430;&#x441;&#x441;:
        <div style="margin-left: 15px; display: flex; gap: 20px;">
          <span> &#x412;&#x441;&#x435;&#x433;&#x43E;: <b>2</b> </span>
          <span class="text-muted"> &#x41F;&#x43E; &#x442;&#x430;&#x440;&#x438;&#x444;&#x443;: 1 </span>
          <span class="text-info"> &#x424;&#x430;&#x43A;&#x442;&#x438;&#x447;&#x435;&#x441;&#x43A;&#x438;: <b>1</b> </span>
        </div>
      </div>
      <div style="padding-bottom: 5px;">
        &#x41C;&#x435;&#x441;&#x442;&#x43E; &#x43D;&#x430; &#x434;&#x438;&#x441;&#x43A;&#x435; &#x43F;&#x43E;&#x434; &#x444;&#x430;&#x439;&#x43B;&#x44B;, &#x41C;&#x411;:
        <div style="margin-left: 15px; display: flex; gap: 20px;">
          <span> &#x412;&#x441;&#x435;&#x433;&#x43E;: <b>512</b> </span>
          <span class="text-muted"> &#x41F;&#x43E; &#x442;&#x430;&#x440;&#x438;&#x444;&#x443;: 512 </span>
          <span class="text-info"> &#x424;&#x430;&#x43A;&#x442;&#x438;&#x447;&#x435;&#x441;&#x43A;&#x438;: <b>0</b> </span>
        </div>
      </div>
    </div>
  </div>
</div>
`;

describe('parsePartnerAccountOverview', () => {
  it('parses KPIs, tariff name and limits from encoded Detail HTML', () => {
    const overview = parsePartnerAccountOverview(SAMPLE_OVERVIEW_HTML);
    assert.equal(overview.status, 'Активен');
    assert.equal(overview.usedLimit, '98.55 / -1');
    assert.equal(overview.tariffCost, '149,000 UZS');
    assert.equal(overview.tariff, 'Basic');
    assert.equal(overview.limits.length, 3);

    const cash = overview.limits.find((row) => row.key === 'cashRegisters');
    assert.ok(cash);
    assert.equal(cash.total, 2);
    assert.equal(cash.included, 1);
    assert.equal(cash.actual, 1);

    const disk = overview.limits.find((row) => row.key === 'diskMb');
    assert.ok(disk);
    assert.equal(disk.total, 512);
  });

  it('returns nulls/empty for unrelated HTML', () => {
    const overview = parsePartnerAccountOverview('<html><body>no data</body></html>');
    assert.equal(overview.status, null);
    assert.equal(overview.usedLimit, null);
    assert.equal(overview.tariffCost, null);
    assert.equal(overview.tariff, null);
    assert.deepEqual(overview.limits, []);
  });
});
