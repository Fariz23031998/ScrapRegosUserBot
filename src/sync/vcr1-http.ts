import type { Unchecked } from '../types/unchecked';
import { VCR1_BASE_URL } from './regos-auth';

const PARTNERS_INDEX_URL = `${VCR1_BASE_URL}/Partners/Index`;
const SESSION_CHECK_TIMEOUT_MS = 15000;

function looksLikeVcr1Login(text?: any, url?: any) {
  const body = String(text || '');
  const href = String(url || '');
  if (/\/account\/login/i.test(href) || /auth\.regos\.uz/i.test(href)) return true;
  if (/войти через regos/i.test(body)) return true;
  return false;
}

/**
 * vcr1 often answers dead sessions with an empty HTTP 500 on /Get instead of login HTML.
 * Probe Partners/Index so callers can refresh the Regos SSO jar.
 */
async function readVcr1ApiText(request: any, response: any, label: any, { timeout = SESSION_CHECK_TIMEOUT_MS }: Unchecked = {}) {
  if (response.ok()) {
    const text = await response.text();
    if (text.trimStart().startsWith('<!')) {
      throw new Error(`vcr1 ${label} returned login/HTML (session expired)`);
    }
    return text;
  }

  try {
    const index = await request.get(PARTNERS_INDEX_URL, { timeout });
    const body = await index.text();
    if (looksLikeVcr1Login(body, index.url())) {
      throw new Error(`vcr1 ${label} returned login/HTML (session expired)`);
    }
  } catch (err: any) {
    if (/session expired/i.test(String(err?.message || err))) throw err;
  }

  throw new Error(`vcr1 ${label} failed with status ${response.status()}`);
}

export { looksLikeVcr1Login, readVcr1ApiText };
