const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseAdminTableHtml } = require('../src/sync/rpos-html');

describe('parseAdminTableHtml', () => {
  it('parses Django admin result_list headers and rows', () => {
    const html = `
      <html><body>
      <table id="result_list">
        <thead>
          <tr>
            <th>ID</th>
            <th>Имя</th>
            <th>Телефон</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>573</th>
            <td>Исроилов Боходир</td>
            <td>+998942423366</td>
          </tr>
        </tbody>
      </table>
      </body></html>
    `;

    const parsed = parseAdminTableHtml(html);
    assert.deepEqual(parsed.headers, ['ID', 'Имя', 'Телефон']);
    assert.equal(parsed.rows.length, 1);
    assert.deepEqual(parsed.rows[0], ['573', 'Исроилов Боходир', '+998942423366']);
  });

  it('returns empty when result_list is missing', () => {
    assert.deepEqual(parseAdminTableHtml('<html></html>'), { headers: [], rows: [] });
  });
});
