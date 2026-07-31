const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  assetVersionForPublicUrl,
  withAssetVersions,
} = require('../src/http/asset-cache');
const { publicDir } = require('../src/paths');

describe('asset cache busting', () => {
  it('versions local css/js urls from file content', () => {
    const cssPath = path.join(publicDir(), 'bot-admin', 'admin.css');
    const expected = crypto.createHash('sha1').update(fs.readFileSync(cssPath)).digest('hex').slice(0, 10);

    assert.equal(assetVersionForPublicUrl('/bot-admin/admin.css'), expected);

    const html = withAssetVersions(`
      <link rel="stylesheet" href="/bot-admin/admin.css" />
      <script src="/bot-admin/admin-order-logs.js"></script>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Inter" />
    `);

    assert.match(html, new RegExp(`/bot-admin/admin\\.css\\?v=${expected}`));
    assert.match(html, /\/bot-admin\/admin-order-logs\.js\?v=[a-f0-9]{10}/);
    assert.match(html, /https:\/\/fonts\.googleapis\.com\/css\?family=Inter/);
  });

  it('changes the version when the asset file changes', () => {
    const tempName = `cache-bust-${process.pid}-${Date.now()}.css`;
    const absolute = path.join(publicDir(), 'bot-admin', tempName);
    const url = `/bot-admin/${tempName}`;

    fs.writeFileSync(absolute, 'body{color:red}');
    const first = assetVersionForPublicUrl(url);
    // ensure mtime can change on filesystems with coarse resolution
    const then = Date.now() + 1100;
    fs.utimesSync(absolute, then / 1000, then / 1000);
    fs.writeFileSync(absolute, 'body{color:blue}');
    const second = assetVersionForPublicUrl(url);

    try {
      assert.notEqual(first, second);
      assert.match(withAssetVersions(`<link href="${url}">`), new RegExp(`\\?v=${second}`));
    } finally {
      fs.unlinkSync(absolute);
    }
  });
});
