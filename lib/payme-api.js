const { requiredEnv, isTestMode, getPaymeSecretKey } = require('./payme');

const RECEIPT_STATE_OPEN = 0;
const RECEIPT_STATE_PAID = 4;

class PaymeApiError extends Error {
  constructor(error) {
    const message = error?.message || error?.data || 'Payme API error';
    super(typeof message === 'string' ? message : JSON.stringify(message));
    this.code = error?.code;
    this.paymeError = error;
  }
}

function getPaymeApiUrl() {
  const host = isTestMode() ? 'https://checkout.test.paycom.uz' : 'https://checkout.paycom.uz';
  return `${host}/api`;
}

function getPaymeAuthHeader() {
  const merchantId = requiredEnv('PAYME_MERCHANT_ID');
  const key = getPaymeSecretKey();
  return `${merchantId}:${key}`;
}

async function paymeRpcCall(method, params, requestId = Date.now()) {
  const response = await fetch(getPaymeApiUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Auth': getPaymeAuthHeader(),
      'Cache-Control': 'no-cache',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method,
      params,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new PaymeApiError({ message: `HTTP ${response.status}` });
  }
  if (data.error) {
    throw new PaymeApiError(data.error);
  }
  return data.result;
}

async function createReceipt({ amountTiyin, account, description }) {
  const result = await paymeRpcCall('receipts.create', {
    amount: amountTiyin,
    account,
    description,
  });
  return result.receipt;
}

async function checkReceipt(receiptId) {
  return paymeRpcCall('receipts.check', { id: receiptId });
}

async function getReceipt(receiptId) {
  const result = await paymeRpcCall('receipts.get', { id: receiptId });
  return result.receipt;
}

module.exports = {
  PaymeApiError,
  RECEIPT_STATE_OPEN,
  RECEIPT_STATE_PAID,
  createReceipt,
  checkReceipt,
  getReceipt,
};
