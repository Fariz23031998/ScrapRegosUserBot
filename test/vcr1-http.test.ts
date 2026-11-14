import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeVcr1Login, readVcr1ApiText } from '../src/sync/vcr1-http';

describe('vcr1 http session helpers', () => {
  it('detects the vcr1 login page', () => {
    assert.equal(
      looksLikeVcr1Login('<html>Войти через Regos ID</html>', 'https://vcr1.regos.uz/account/login'),
      true
    );
    assert.equal(looksLikeVcr1Login('{"data":[]}', 'https://vcr1.regos.uz/Partners/Get'), false);
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
            return '<html>Войти через Regos ID</html>';
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
