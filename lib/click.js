const crypto = require('crypto');

const CLICK_PAYMENT_BASE_URL = 'https://my.click.uz/services/pay';

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in environment`);
  }
  return value;
}

function formatClickUrl(orderId, amount) {
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

function clickGenerateSignString(payload) {
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

function verifyClickSignature(payload) {
  if (!payload?.sign_string) return false;
  return clickGenerateSignString(payload) === payload.sign_string;
}

module.exports = {
  formatClickUrl,
  verifyClickSignature,
};
