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

function findVipClientIndex(phone, vipClients = loadVipClients()) {
  const { phonesMatch } = require('./search-user');
  return vipClients.findIndex((vipPhone) => phonesMatch(vipPhone, phone));
}

function saveVipClients(phones, filePath = DEFAULT_VIP_CLIENTS_PATH) {
  const content = phones.join(',');
  fs.writeFileSync(filePath, content, 'utf8');
}

function formatVipList(vipClients = loadVipClients()) {
  if (vipClients.length === 0) {
    return 'VIP-список пуст';
  }

  return ['VIP-клиенты:', ...vipClients.map((phone, index) => `${index + 1}. ${phone}`)].join('\n');
}

function addVipClient(phone, filePath = DEFAULT_VIP_CLIENTS_PATH) {
  const trimmed = String(phone || '').trim();
  if (!trimmed) {
    return { ok: false, message: 'Неверный номер телефона.' };
  }

  const vipClients = loadVipClients(filePath);
  if (findVipClientIndex(trimmed, vipClients) >= 0) {
    return { ok: false, message: 'Этот номер уже в VIP-списке.' };
  }

  vipClients.push(trimmed);
  saveVipClients(vipClients, filePath);
  return { ok: true, message: `Добавлено: ${trimmed}` };
}

function removeVipClient(phone, filePath = DEFAULT_VIP_CLIENTS_PATH) {
  const trimmed = String(phone || '').trim();
  if (!trimmed) {
    return { ok: false, message: 'Неверный номер телефона.' };
  }

  const vipClients = loadVipClients(filePath);
  const index = findVipClientIndex(trimmed, vipClients);
  if (index < 0) {
    return { ok: false, message: 'Номер не найден в VIP-списке.' };
  }

  const removed = vipClients.splice(index, 1)[0];
  saveVipClients(vipClients, filePath);
  return { ok: true, message: `Удалено: ${removed}` };
}

module.exports = {
  DEFAULT_VIP_CLIENTS_PATH,
  VIP_LABEL,
  loadVipClients,
  isVipClient,
  extractPhoneFromText,
  findVipClientIndex,
  saveVipClients,
  formatVipList,
  addVipClient,
  removeVipClient,
};
