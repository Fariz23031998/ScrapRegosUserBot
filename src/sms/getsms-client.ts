import type { Unchecked } from '../types/unchecked';
import { formatPhoneForSms } from './sms-message';

const DEFAULT_GETSMS_URL = 'http://185.8.212.184/smsgateway/';

function getGetSmsCredentials() {
  return {
    login: process.env.GETSMS_LOGIN?.trim() || '',
    password: process.env.GETSMS_PASSWORD?.trim() || '',
  };
}

function isGetSmsConfigured() {
  const { login, password } = getGetSmsCredentials();
  return Boolean(login && password);
}

function isGetSmsEnabled() {
  return process.env.ENABLE_GETSMS?.trim() === '1' && isGetSmsConfigured();
}

function getGetSmsError(item?: any, status?: any) {
  const number = item?.error_no != null ? ` ${item.error_no}` : '';
  const detail = item?.error_text || item?.text;
  if (detail) return `GETSMS error${number}: ${detail}`;
  if (status) return `GETSMS request failed with HTTP ${status}`;
  return `GETSMS error${number}`.trim();
}

async function sendGetSms({ phone, text }: Unchecked, { fetchImpl = globalThis.fetch }: Unchecked = {}) {
  if (!isGetSmsConfigured()) {
    throw new Error('GETSMS_LOGIN and GETSMS_PASSWORD are required');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch API is not available');
  }

  const formattedPhone = formatPhoneForSms(phone);
  if (!formattedPhone) {
    throw new Error('Invalid SMS recipient phone');
  }

  const { login, password } = getGetSmsCredentials();
  const params = new URLSearchParams();
  params.set('login', login);
  params.set('password', password);

  const nickname = process.env.GETSMS_NICKNAME?.trim();
  if (nickname) {
    params.set('nickname', nickname);
  }
  params.set('data', JSON.stringify([{ phone: formattedPhone, text: String(text ?? '') }]));

  const response = await fetchImpl(process.env.GETSMS_URL?.trim() || DEFAULT_GETSMS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'ScrapRegosUserBot/1.0',
    },
    body: params.toString(),
  });

  const raw = await response.text();
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`GETSMS returned invalid JSON (HTTP ${response.status})`);
  }

  const items = Array.isArray(parsed) ? parsed : [parsed];
  const failedItem = items.find((item?: any) => item?.error || item?.error_no);
  if (!response.ok || failedItem) {
    throw new Error(getGetSmsError(failedItem, response.status));
  }

  const successfulItem = items.find((item?: any) => item?.request_id != null);
  if (!successfulItem) {
    throw new Error('GETSMS response did not include request_id');
  }

  return {
    requestId: successfulItem.request_id,
    messageId: successfulItem.message_id ?? null,
    recipient: formattedPhone,
  };
}

export {
  DEFAULT_GETSMS_URL,
  isGetSmsConfigured,
  isGetSmsEnabled,
  sendGetSms,
};
