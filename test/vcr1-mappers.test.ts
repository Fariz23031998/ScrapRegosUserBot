import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { vcr1PartnerFromApiRow, vcr1LicenseFromApiRow } from '../src/live/mappers';
import { buildFormData as buildPartnersForm, COLUMNS as PARTNER_COLUMNS } from '../src/sync/vcr1-partners-api';
import { buildFormData as buildLicensesForm } from '../src/sync/vcr1-licenses-api';

describe('vcr1 mappers and form builders (Billing 1.22)', () => {
  it('maps partner rows from Partners/Get', () => {
    const mapped = vcr1PartnerFromApiRow({
      id: 1592,
      name: 'Example Partner',
      inn: '123456789',
      legal_status: 'Legal',
      contacts: null,
      phone: '998901234567',
      balance: '0.00',
      company: 'ООО Example',
    });
    assert.equal(mapped.id, 1592);
    assert.equal(mapped.phone, '998901234567');
    assert.equal(mapped.company, 'ООО Example');
    assert.equal(mapped.registered_at, null);
  });

  it('maps license rows including monthly_fee', () => {
    const mapped = vcr1LicenseFromApiRow({
      id: 136,
      create: '05.10.2021 18:56:35',
      license: 'abc',
      serial: 'VCR210201-T8E',
      fm: 'UZ210317254112',
      partner: 'Example Partner (123456789)',
      contract: 'IVO-VCR-9 от 04.10.2021',
      status: 'Активна',
      monthly_fee: '75,000.00',
      last_sync: '18.11.2026 23:12:09',
      last_receipt_date: '18.11.2026 20:32:16',
      last_check_attempt: '18.11.2026 23:12:09',
      app_build_time: '07.11.2026',
      fda_version: '8.49',
      db_version: '146',
    });
    assert.equal(mapped.created_at, '05.10.2021 18:56:35');
    assert.equal(mapped.monthly_fee, '75,000.00');
    assert.equal(mapped.serial, 'VCR210201-T8E');
  });

  it('builds partners form with archived additionalproperty and UI columns', () => {
    const form = buildPartnersForm({ draw: 1, start: 0, length: 50, search: '998' });
    assert.equal(form['additionalproperty[2][name]'], 'archived');
    assert.equal(form['search[value]'], '998');
    assert.deepEqual(PARTNER_COLUMNS, ['id', 'name', 'inn', 'phone', 'company', 'balance']);
    assert.equal(form['columns[0][data]'], 'id');
    assert.equal(form['columns[5][data]'], 'balance');
  });

  it('builds licenses form with status additionalproperty', () => {
    const form = buildLicensesForm({ draw: 1, start: 0, length: 50, search: 'VCR' });
    assert.equal(form['additionalproperty[0][name]'], 'status');
    assert.equal(form['columns[2][data]'], 'create');
    assert.equal(form['columns[13][data]'], 'id');
  });
});
