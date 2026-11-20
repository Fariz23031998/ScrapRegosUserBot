import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeVcr1Login, readVcr1ApiText } from '../src/sync/vcr1-http';

describe('vcr1 http session helpers', () => {
  it('detects the legacy vcr1 login page', () => {
    assert.equal(
      looksLikeVcr1Login('<html>Войти через Regos ID</html>', 'https://vcr1.regos.uz/account/login'),
      true
    );
    assert.equal(looksLikeVcr1Login('{"data":[]}', 'https://vcr1.regos.uz/Partners/Get'), false);
  });

  it('detects Billing 1.22 hosted account login HTML', () => {
    assert.equal(
      looksLikeVcr1Login(
        '<html><body><h1>Вход в биллинг</h1><span>Единый профиль REGOS</span></body></html>',
        'https://vcr1.regos.uz/Partners/Index'
      ),
      true
    );
    assert.equal(
      looksLikeVcr1Login(
        '<div id="hosted-account-shell" data-login-page="true"></div>',
        'https://vcr1.regos.uz/Billing/Search'
      ),
      true
    );
  });

  it('maps HTTP 401 to session expired', async () => {
    const response = {
      ok: () => false,
      status: () => 401,
      async text() {
        return '';
      },
      url: () => 'https://vcr1.regos.uz/Partners/Get',
    };

    await assert.rejects(
      () => readVcr1ApiText({}, response, 'Partners/Get'),
      /session expired/i
    );
  });

  it('maps an empty HTTP 500 to session expired when Index is a login page', async () => {
    const response = {
      ok: () => false,
      status: () => 500,
      async text() {
        return '';
      },
      url: () => 'https://vcr1.regos.uz/Partners/Get',
    };
    const request = {
      async get() {
        return {
          async text() {
            return '<html><h1>Вход в биллинг</h1></html>';
          },
          url: () => 'https://vcr1.regos.uz/account/login',
        };
      },
    };

    await assert.rejects(
      () => readVcr1ApiText(request, response, 'Partners/Get'),
      /session expired/i
    );
  });

  it('keeps a real HTTP 500 when Index is authenticated', async () => {
    const response = {
      ok: () => false,
      status: () => 500,
      async text() {
        return '';
      },
      url: () => 'https://vcr1.regos.uz/Partners/Get',
    };
    const request = {
      async get() {
        return {
          async text() {
            return '<html><title>Клиенты</title></html>';
          },
          url: () => 'https://vcr1.regos.uz/Partners/Index',
        };
      },
    };

    await assert.rejects(
      () => readVcr1ApiText(request, response, 'Partners/Get'),
      /failed with status 500/
    );
  });

  it('returns JSON text for a healthy response', async () => {
    const response = {
      ok: () => true,
      status: () => 200,
      async text() {
        return '{"data":[]}';
      },
      url: () => 'https://vcr1.regos.uz/Partners/Get',
    };
    const text = await readVcr1ApiText({}, response, 'Partners/Get');
    assert.equal(text, '{"data":[]}');
  });
});
