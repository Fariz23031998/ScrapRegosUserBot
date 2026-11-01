import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatLicense,
  formatPartner,
  formatRposAccount,
  formatRposClient,
  formatVcr1License,
  formatVcr1Partner,
} from '../src/bot/search-user-format';

describe('billing page label on firm cards', () => {
  const partner = {
    id: 1,
    name: 'Acme',
    phone: '+998901112233',
  };

  it('labels a Samarkand REGOS firm', () => {
    const message = formatPartner({ ...partner, _account: 'SAMARKAND' });
    assert.match(message, /^🏢 <b>REGOS \(Samarkand\)<\/b>/);
  });

  it('labels a Bukhara REGOS firm', () => {
    const message = formatPartner({ ...partner, _account: 'BUKHARA' });
    assert.match(message, /^🏢 <b>REGOS \(Bukhara\)<\/b>/);
  });

  it('omits the city when the billing page is unknown', () => {
    const message = formatPartner(partner);
    assert.match(message, /^🏢 <b>REGOS<\/b>/);
    assert.doesNotMatch(message, /Samarkand|Bukhara/);
    assert.doesNotMatch(message, /Аккаунт/);
  });

  it('shows one related account, several accounts, or none', () => {
    const one = formatPartner(partner, {
      api_login: 'DB260486-B0BRX2',
      status: 'Активен',
      api_server: 'APIUZB0003',
      tariff: 'Basic',
      paid_until: '01.12.2026 23:59:59',
      dealer_create: 'ООО ROFEEV',
      date_create: '01.11.2026 14:31:02',
    });
    assert.match(one, /Аккаунт:<\/b> DB260486-B0BRX2/);
    assert.match(one, /Статус:<\/b> Активен/);
    assert.match(one, /Сервер API:<\/b> APIUZB0003/);
    assert.match(one, /Тариф:<\/b> Basic/);
    assert.match(one, /Оплачено до:<\/b> 01\.12\.2026 23:59:59/);
    assert.match(one, /Создавший партнёр:<\/b> ООО ROFEEV/);
    assert.match(one, /Создан:<\/b> 01\.11\.2026 14:31:02/);

    const many = formatPartner(partner, [
      { api_login: 'DB1' },
      { api_login: 'DB2' },
    ]);
    assert.match(many, /Аккаунт:<\/b> DB1/);
    assert.match(many, /Аккаунт:<\/b> DB2/);

    assert.doesNotMatch(formatPartner(partner, []), /Аккаунт/);
  });

  it('labels EasyTrade, VCR, and RPOS cards', () => {
    assert.match(
      formatLicense({ id: 2, fio: 'Ada', _account: 'SAMARKAND' }),
      /^🧾 <b>EasyTrade \(Samarkand\)<\/b>/
    );
    assert.match(
      formatVcr1Partner({ id: 3, name: 'Ada', _account: 'BUKHARA' }),
      /^📟 <b>VCR \(Bukhara\)<\/b>/
    );
    assert.match(
      formatVcr1License({ id: 4 }, { _account: 'SAMARKAND' }),
      /^📟 <b>VCR \(Samarkand\)<\/b>/
    );
    assert.match(
      formatRposClient({ id: 5, name: 'Ada', source_account: 'BUKHARA' }),
      /^🖥️ <b>RPOS \(Bukhara\)<\/b>/
    );
    assert.match(
      formatRposAccount({ id: 6, client_name: 'Ada', source_account: 'SAMARKAND' }),
      /^🖥️ <b>RPOS \(Samarkand\)<\/b>/
    );
  });
});
