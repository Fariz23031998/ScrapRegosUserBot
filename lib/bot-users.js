const fs = require('fs');
const path = require('path');
const { phonesMatch } = require('./search-user');

const DEFAULT_ALLOWLIST_PATH = path.join(__dirname, '..', 'users_phones.txt');

function loadAllowedPhones(filePath = DEFAULT_ALLOWLIST_PATH) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split(',')
    .map((phone) => phone.trim())
    .filter(Boolean);
}

function isPhoneAllowed(phone, allowedPhones = loadAllowedPhones()) {
  return allowedPhones.some((allowed) => phonesMatch(allowed, phone));
}

function normalizeRegisteredPhone(phone, allowedPhones = loadAllowedPhones()) {
  const match = allowedPhones.find((allowed) => phonesMatch(allowed, phone));
  return match ?? phone.trim();
}

module.exports = {
  DEFAULT_ALLOWLIST_PATH,
  loadAllowedPhones,
  isPhoneAllowed,
  normalizeRegisteredPhone,
};
