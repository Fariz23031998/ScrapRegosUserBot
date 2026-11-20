import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { completeRegosIdLoginForm } from '../src/sync/regos-auth';
import { REFRESH_FAILURE_COOLDOWN_MS, regosSessionRecovery } from '../src/live/session-manager';

function loginPage(present: boolean) {
  const filled: Record<string, string> = {};
  const clicked: string[] = [];
  return {
    filled,
    clicked,
    locator(selector: string) {
      return {
        async count() {
          return present && selector === '#PhoneNumber' ? 1 : present ? 1 : 0;
        },
        async fill(value: string) {
          filled[selector] = value;
        },
      };
    },
    getByRole(_role: string, query: { name: RegExp }) {
      return {
        async click() {
          clicked.push(String(query.name));
        },
      };
    },
  };
}

describe('vcr1 Regos ID login form', () => {
  it('submits the account phone and password instead of waiting on the form', async () => {
    const page = loginPage(true);
    const submitted = await completeRegosIdLoginForm(page, {
      phone: '+998901112233',
      password: 'secret',
    });
    assert.equal(submitted, true);
    assert.equal(page.filled['#PhoneNumber'], '+998901112233');
    assert.equal(page.filled['#Password'], 'secret');
    assert.equal(page.clicked.length, 1);
  });

  it('fails immediately when the form is up and credentials were not passed', async () => {
    const page = loginPage(true);
    await assert.rejects(
      () => completeRegosIdLoginForm(page, null),
      /phone and password/
    );
    assert.deepEqual(page.filled, {});
    assert.deepEqual(page.clicked, []);
  });

  it('leaves consent and device pages alone', async () => {
    const page = loginPage(false);
    assert.equal(await completeRegosIdLoginForm(page, { phone: '1', password: '2' }), false);
  });
});

describe('expired Regos sessions renew on the request', () => {
  const now = 1_700_000_000_000;

  it('renews and retries a vcr1 login page or HTTP 401', () => {
    assert.equal(
      regosSessionRecovery(new Error('vcr1 Partners/Get returned login/HTML (session expired)'), { now }),
      'renew'
    );
    assert.equal(
      regosSessionRecovery(
        new Error('SAMARKAND vcr1_partners: vcr1 Partners/Get failed with status 401'),
        { now }
      ),
      'renew'
    );
  });

  it('still renews when the main billing session is dead, including during the vcr1 cooldown', () => {
    const refreshFailedAt = now - 10_000;
    assert.equal(
      regosSessionRecovery(new Error('Partners/Get returned login/HTML (session expired)'), {
        refreshFailedAt,
        now,
      }),
      'renew'
    );
    assert.equal(
      regosSessionRecovery(new Error('Partners/Get failed with status 500'), { refreshFailedAt, now }),
      'rethrow'
    );
  });

  it('does not launch another browser when vcr1 login failed inside the cooldown', () => {
    const refreshFailedAt = now - 10_000;
    assert.ok(now - refreshFailedAt < REFRESH_FAILURE_COOLDOWN_MS);
    assert.equal(
      regosSessionRecovery(new Error('vcr1 Partners/Get returned login/HTML (session expired)'), {
        refreshFailedAt,
        now,
      }),
      'skip'
    );
    assert.equal(
      regosSessionRecovery(new Error('vcr1 Partners/Get returned login/HTML (session expired)'), {
        refreshFailedAt: now - REFRESH_FAILURE_COOLDOWN_MS,
        now,
      }),
      'renew'
    );
  });
});
