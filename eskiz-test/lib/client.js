'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const EMAIL = process.env.ESKIZ_EMAIL;
const PASSWORD = process.env.ESKIZ_PASSWORD;
const BASE_URL = (process.env.ESKIZ_BASE_URL || 'https://notify.eskiz.uz').replace(/\/$/, '');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function requireCredentials() {
  if (!EMAIL || !PASSWORD) {
    fail('Set ESKIZ_EMAIL and ESKIZ_PASSWORD in .env');
  }
}

async function login() {
  requireCredentials();

  const form = new FormData();
  form.append('email', EMAIL);
  form.append('password', PASSWORD);

  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'User-Agent': 'eskiz-test/1.0' },
    body: form,
  });
  const raw = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`Login response is not JSON (HTTP ${res.status}): ${raw}`);
  }
  const token = parsed?.data?.token;
  if (!res.ok || !token) {
    fail(`Login failed (HTTP ${res.status}): ${raw}`);
  }
  return token;
}

async function authFetch(pathname, { method = 'GET', body, headers = {} } = {}) {
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
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  return { token, res, raw, parsed };
}

module.exports = {
  BASE_URL,
  EMAIL,
  PASSWORD,
  fail,
  requireCredentials,
  login,
  authFetch,
};
