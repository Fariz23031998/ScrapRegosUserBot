const fs = require('fs');
const path = require('path');

const DEFAULT_VIP_CLIENTS_PATH = path.join(__dirname, '..', 'vip_clients.txt');
const VIP_LABEL = '😎 VIP-клиент';

function loadVipClients(filePath = DEFAULT_VIP_CLIENTS_PATH) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split(',')
    .map((phone) => phone.trim())
    .filter(Boolean);
}

function isVipClient(phone, vipClients = loadVipClients()) {
  if (!phone) return false;
  const { phonesMatch } = require('./search-user');
  return vipClients.some((vipPhone) => phonesMatch(vipPhone, phone));
}

function extractPhoneFromText(text) {
  const matches = String(text || '').match(/\+?\d[\d\s()-]{8,}/g);
  if (!matches) return null;

  return matches.sort((a, b) => b.replace(/\D/g, '').length - a.replace(/\D/g, '').length)[0];
}

module.exports = {
  DEFAULT_VIP_CLIENTS_PATH,
  VIP_LABEL,
  loadVipClients,
  isVipClient,
  extractPhoneFromText,
};
