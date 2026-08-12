'use strict';

const { BASE_URL, authFetch, fail } = require('./lib/client');

const templateFromArgv = process.argv.slice(2).join(' ').trim();
const template = templateFromArgv || process.env.ESKIZ_TEMPLATE?.trim() || '';

if (!template) {
  fail(
    'Provide template text via argv or ESKIZ_TEMPLATE in .env\n' +
      '  npm run templates:create -- "Your SMS template text here"\n' +
      '  ESKIZ_TEMPLATE="Your SMS template text here" npm run templates:create'
  );
}

async function main() {
  console.log(`POST ${BASE_URL}/api/user/template`);
  console.log(`Template (${template.length} chars):`);
  console.log(template);
  console.log('');

  const form = new FormData();
  form.append('template', template);

  const { res, raw, parsed } = await authFetch('/api/user/template', {
    method: 'POST',
    body: form,
  });

  console.log(`HTTP ${res.status}`);
  console.log(raw);
  console.log('');

  if (!res.ok) {
    fail(parsed?.message || parsed?.error || `Create template failed (HTTP ${res.status})`);
  }

  console.log('Template submitted for moderation.');
  console.log('Check status with: npm run templates:list');
  console.log('See docs/eskiz-templates.md for statuses and matching rules.');
}

main().catch((err) => {
  fail(err.message || String(err));
});
