const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyProbeResponse,
  classifyThrownProbe,
  maintainPortalSessions,
  resolveIntervalMs,
  startSessionKeepalive,
} = require('../src/live/session-keepalive');

describe('classifyProbeResponse', () => {
  it('treats HTTP 401 as an expired session', () => {
    assert.equal(classifyProbeResponse({ status: 401, body: 'denied', url: '' }), 'expired');
    assert.equal(
      classifyThrownProbe(new Error('Partners/Get failed with status 401')),
      'expired'
    );
  });

  it('treats a login page as an expired session', () => {
    assert.equal(
      classifyProbeResponse({
        status: 200,
        body: '<html>Войти через Regos</html>',
        url: 'https://sb.regos.uz/account/login',
      }),
      'expired'
    );
    assert.equal(
      classifyThrownProbe(new Error('Partners/Get returned login/HTML (session expired)')),
      'expired'
    );
  });

  it('treats a JSON body as a live session', () => {
    assert.equal(
      classifyProbeResponse({
        status: 200,
        body: '{"data":[]}',
        url: 'https://sb.regos.uz/Partners/Get',
      }),
      'ok'
    );
  });

  it('does not treat an HTTP 500 as an expired session', () => {
    assert.equal(classifyProbeResponse({ status: 500, body: 'error', url: '' }), 'error');
    assert.equal(
      classifyThrownProbe(new Error('vcr1 Partners/Get failed with status 500')),
      'error'
    );
  });
});

describe('session keepalive worker', () => {
  it('logs in only for an expired probe', async () => {
    const refreshed = [];
    await maintainPortalSessions({
      accounts: ['BUKHARA', 'SAMARKAND'],
      probeRegos: async (account) => (account === 'BUKHARA' ? 'expired' : 'ok'),
      probeRpos: async () => 'ok',
      hasRpos: (account) => account === 'SAMARKAND',
      refreshRegos: async (account) => {
        refreshed.push(account);
      },
      refreshRpos: async () => {
        throw new Error('rpos should stay warm');
      },
      log: { log() {}, error() {} },
    });
    assert.deepEqual(refreshed, ['BUKHARA']);
  });

  it('does not start a second tick while the first is running', async () => {
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const worker = startSessionKeepalive({
      intervalMs: 60_000,
      maintainSessions: async () => {
        calls += 1;
        await gate;
      },
    });
    try {
      const first = worker.tick();
      await worker.tick();
      assert.equal(calls, 1);
      release();
      await first;
      assert.equal(calls, 1);
    } finally {
      worker.stop();
    }
  });

  it('uses five minutes by default and zero disables the worker', () => {
    assert.equal(resolveIntervalMs(''), 5 * 60 * 1000);
    assert.equal(resolveIntervalMs('0'), 0);
    assert.equal(resolveIntervalMs('15000'), 15000);
    assert.equal(resolveIntervalMs('nope'), 5 * 60 * 1000);
  });
});
