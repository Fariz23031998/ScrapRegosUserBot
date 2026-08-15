const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  formatClientNotifyLines,
  buildEmployeeNotifyText,
} = require('../src/ai/tools/notify-employee');
const { truncateTelegramText } = require('../src/ai/tools/notify-group');

describe('notify employee text', () => {
  const previousBase = process.env.PUBLIC_BASE_URL;

  before(() => {
    process.env.PUBLIC_BASE_URL = 'https://example.test';
  });

  after(() => {
    if (previousBase == null) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousBase;
  });

  it('formats non-empty client fields', () => {
    assert.deepEqual(
      formatClientNotifyLines({
        name: 'Иван',
        phone: '+998901112233',
        id: 42,
        email: 'ivan@example.com',
      }),
      ['Клиент: Иван', 'Телефон: +998901112233', 'ID клиента: 42', 'Email: ivan@example.com'],
    );
  });

  it('omits empty client fields', () => {
    assert.deepEqual(formatClientNotifyLines({ name: ' ', phone: '', id: null, email: null }), []);
    assert.deepEqual(formatClientNotifyLines({ name: 'Али', phone: '' }), ['Клиент: Али']);
    assert.deepEqual(formatClientNotifyLines(null), []);
  });

  it('appends client block and ticket link after the message', () => {
    const text = buildEmployeeNotifyText({
      message: 'Нужна помощь с ККМ',
      ticketId: 456,
      client: { name: 'Иван', phone: '+998901112233', id: 12 },
    });
    assert.equal(
      text,
      [
        'Нужна помощь с ККМ',
        '',
        'Клиент: Иван',
        'Телефон: +998901112233',
        'ID клиента: 12',
        '',
        'Тикет: https://example.test/bot-admin/tickets/456',
      ].join('\n'),
    );
  });

  it('keeps ticket link when client is missing', () => {
    const text = buildEmployeeNotifyText({
      message: 'Проверка',
      ticketId: 7,
    });
    assert.equal(text, 'Проверка\n\nТикет: https://example.test/bot-admin/tickets/7');
  });

  it('truncates long group messages after building full text', () => {
    const longMessage = 'x'.repeat(4100);
    const built = buildEmployeeNotifyText({
      message: longMessage,
      ticketId: 1,
      client: { name: 'Клиент', phone: '123' },
    });
    const truncated = truncateTelegramText(built);
    assert.ok(truncated.length <= 4096);
    assert.ok(truncated.endsWith('...'));
    assert.ok(built.length > truncated.length);
  });
});
