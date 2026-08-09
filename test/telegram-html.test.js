const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  escapeHtml,
  bold,
  code,
  field,
  link,
  withHtml,
  TELEGRAM_HTML,
} = require('../src/bot/telegram-html');

describe('telegram-html helpers', () => {
  it('escapes &, <, and >', () => {
    assert.equal(escapeHtml('A & B <C>'), 'A &amp; B &lt;C&gt;');
    assert.equal(escapeHtml(null), '');
  });

  it('formats bold, code, and field lines', () => {
    assert.equal(bold('Заказ оплачен.'), '<b>Заказ оплачен.</b>');
    assert.equal(code('abc&1'), '<code>abc&amp;1</code>');
    assert.equal(field('🆔', 'ID', '12<3'), '🆔 <b>ID:</b> 12&lt;3');
  });

  it('builds safe http(s) links and rejects unsafe urls', () => {
    assert.equal(
      link('https://example.com/pay?x=1&y=2', 'Страница оплаты'),
      '<a href="https://example.com/pay?x=1&amp;y=2">Страница оплаты</a>'
    );
    assert.equal(link('javascript:alert(1)', 'x'), 'x');
    assert.equal(link('not-a-url', 'label'), 'label');
  });

  it('merges parse_mode into send options', () => {
    assert.deepEqual(TELEGRAM_HTML, { parse_mode: 'HTML' });
    assert.deepEqual(withHtml({ reply_markup: { inline_keyboard: [] } }), {
      reply_markup: { inline_keyboard: [] },
      parse_mode: 'HTML',
    });
    assert.deepEqual(withHtml(), { parse_mode: 'HTML' });
  });
});
