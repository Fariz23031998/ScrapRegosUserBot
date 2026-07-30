function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in environment`);
  }
  return value;
}

function isTestMode() {
  return process.env.PAYME_TEST_MODE === '1';
}

function getPaymeSecretKey() {
  return isTestMode() ? requiredEnv('PAYME_TEST_KEY') : requiredEnv('PAYME_SECRET_KEY');
}

function uzsToTiyin(amountUzs) {
  return Math.trunc(Number(amountUzs)) * 100;
}

function getPaymeCheckoutBase() {
  return isTestMode() ? 'https://test.paycom.uz' : 'https://checkout.paycom.uz';
}

module.exports = {
  requiredEnv,
  isTestMode,
  getPaymeSecretKey,
  uzsToTiyin,
  getPaymeCheckoutBase,
};
