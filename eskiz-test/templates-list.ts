import { BASE_URL, authFetch, fail } from './lib/client';

const STATUS_LABELS: Record<string, string> = {
  moderation: 'На модерации',
  inproccess: 'В процессе',
  service: 'Сервисный',
  reklama: 'Рекламный',
  rejected: 'Отказано',
};

function formatStatus(status: string | undefined): string {
  if (!status) return '(unknown)';
  const label = STATUS_LABELS[status] || status;
  return `${status} (${label})`;
}

async function main(): Promise<void> {
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

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  fail(message);
});
