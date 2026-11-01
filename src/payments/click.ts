import crypto from 'crypto';

const CLICK_PAYMENT_BASE_URL = 'https://my.click.uz/services/pay';

const CLICK_REQUIRED_ENV = ['CLICK_SERVICE_ID', 'CLICK_MERCHANT_ID', 'CLICK_MERCHANT_USER_ID'];

function requiredEnv(name?: any) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in environment`);
  }
  return value;
}

function isClickConfigured() {
  return CLICK_REQUIRED_ENV.every((name?: any) => Boolean(process.env[name]?.trim()));
}

function isClickPaymentEnabled() {
  return process.env.ENABLE_CLICK_PAYMENT === '1' && isClickConfigured();
}

function formatClickUrl(orderId?: any, amount?: any) {
  const serviceId = requiredEnv('CLICK_SERVICE_ID');
  const merchantId = requiredEnv('CLICK_MERCHANT_ID');
  const merchantUserId = requiredEnv('CLICK_MERCHANT_USER_ID');
  const returnUrl = process.env.CLICK_RETURN_URL || 'https://docvision.uz';

  const params = new URLSearchParams({
    service_id: serviceId,
    merchant_id: merchantId,
    merchant_user_id: merchantUserId,
    amount: String(Math.trunc(Number(amount))),
    transaction_param: String(orderId),
    return_url: returnUrl,
  });

  return `${CLICK_PAYMENT_BASE_URL}?${params.toString()}`;
}

function formatClickUrlSafe(orderId?: any, amount?: any) {
  if (!isClickPaymentEnabled()) return null;
  try {
    return formatClickUrl(orderId, amount);
  } catch (error: any) {
    console.warn('[click] Unable to build payment URL:', error.message);
    return null;
  }
}

function clickGenerateSignString(payload?: any) {
  const secretKey = requiredEnv('CLICK_SECRET_KEY');
  const data = [
    payload.click_trans_id,
    payload.service_id,
    secretKey,
    payload.merchant_trans_id,
    payload.merchant_prepare_id || '',
    payload.amount,
    payload.action,
    payload.sign_time,
  ].join('');
  return crypto.createHash('md5').update(data, 'utf8').digest('hex');
}

function verifyClickSignature(payload?: any) {
  if (!payload?.sign_string) return false;
  if (!process.env.CLICK_SECRET_KEY?.trim()) return false;
  return clickGenerateSignString(payload) === payload.sign_string;
}

export {
  formatClickUrl,
  formatClickUrlSafe,
  verifyClickSignature,
  isClickConfigured,
  isClickPaymentEnabled,
};
