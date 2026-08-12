'use strict';

const { BASE_URL, authFetch, fail } = require('./lib/client');

const STATUS_LABELS = {
  moderation: 'На модерации',
  inproccess: 'В процессе',
  service: 'Сервисный',
  reklama: 'Рекламный',
  rejected: 'Отказано',
};

function formatStatus(status) {
  if (!status) return '(unknown)';
  const label = STATUS_LABELS[status] || status;
  return `${status} (${label})`;
}

async function main() {
  console.log(`GET ${BASE_URL}/api/user/templates`);
  console.log('');

  const { res, raw, parsed } = await authFetch('/api/user/templates');

  console.log(`HTTP ${res.status}`);
  console.log(raw);
  console.log('');

  if (!res.ok) {
    fail(parsed?.message || parsed?.error || `List templates failed (HTTP ${res.status})`);
  }

  const items = Array.isArray(parsed?.result) ? parsed.result : [];
  if (!items.length) {
    console.log('No templates returned.');
    return;
  }

  console.log(`Templates: ${items.length}`);
  for (const item of items) {
    const text = item.original_text || item.template || '';
    console.log(`- id=${item.id} status=${formatStatus(item.status)}`);
    console.log(`  text: ${text}`);
  }
}

main().catch((err) => {
  fail(err.message || String(err));
});
