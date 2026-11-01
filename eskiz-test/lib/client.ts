import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const EMAIL = process.env.ESKIZ_EMAIL;
const PASSWORD = process.env.ESKIZ_PASSWORD;
const BASE_URL = (process.env.ESKIZ_BASE_URL || 'https://notify.eskiz.uz').replace(/\/$/, '');

export type EskizJson = {
  data?: { token?: string };
  message?: string;
  error?: string;
  id?: string | number;
  result?: Array<{
    id?: string | number;
    status?: string;
    original_text?: string;
    template?: string;
  }>;
} | null;

export type AuthFetchOptions = {
  method?: string;
  body?: BodyInit;
  headers?: Record<string, string>;
};

export type AuthFetchResult = {
  token: string;
  res: globalThis.Response;
  raw: string;
  parsed: EskizJson;
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function requireCredentials(): void {
  if (!EMAIL || !PASSWORD) {
    fail('Set ESKIZ_EMAIL and ESKIZ_PASSWORD in .env');
  }
}

async function login(): Promise<string> {
  requireCredentials();

  const form = new FormData();
  form.append('email', EMAIL as string);
  form.append('password', PASSWORD as string);

  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'User-Agent': 'eskiz-test/1.0' },
    body: form,
  });
  const raw = await res.text();
  let parsed: EskizJson;
  try {
    parsed = JSON.parse(raw) as EskizJson;
  } catch {
    fail(`Login response is not JSON (HTTP ${res.status}): ${raw}`);
  }
  const token = parsed?.data?.token;
  if (!res.ok || !token) {
    fail(`Login failed (HTTP ${res.status}): ${raw}`);
  }
  return token;
}

async function authFetch(pathname: string, options: AuthFetchOptions = {}): Promise<AuthFetchResult> {
  const { method = 'GET', body, headers = {} } = options;
  const token = await login();
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'eskiz-test/1.0',
      ...headers,
    },
    body,
  });
  const raw = await res.text();
  let parsed: EskizJson = null;
  try {
    parsed = raw ? (JSON.parse(raw) as EskizJson) : null;
  } catch {
    parsed = null;
  }
  return { token, res, raw, parsed };
}

export { BASE_URL, EMAIL, PASSWORD, fail, requireCredentials, login, authFetch };
