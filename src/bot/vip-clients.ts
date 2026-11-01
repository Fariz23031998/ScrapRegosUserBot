import fs from 'fs';
import { vipClientsPath } from '../paths';

const DEFAULT_VIP_CLIENTS_PATH = vipClientsPath();
const VIP_LABEL = '😎 <b>VIP-клиент</b>';

function loadVipClients(filePath: any = DEFAULT_VIP_CLIENTS_PATH) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split(',')
    .map((phone?: any) => phone.trim())
    .filter(Boolean);
}

function isVipClient(phone: any, vipClients: any = loadVipClients()) {
  if (!phone) return false;
  const { phonesMatch } = (require('./search-user') as typeof import('./search-user'));
  return vipClients.some((vipPhone?: any) => phonesMatch(vipPhone, phone));
}

function extractPhoneFromText(text?: any) {
  const matches = String(text || '').match(/\+?\d[\d\s()-]{8,}/g);
  if (!matches) return null;

  return matches.sort((a?: any, b?: any) => b.replace(/\D/g, '').length - a.replace(/\D/g, '').length)[0];
}

function findVipClientIndex(phone: any, vipClients: any = loadVipClients()) {
  const { phonesMatch } = (require('./search-user') as typeof import('./search-user'));
  return vipClients.findIndex((vipPhone?: any) => phonesMatch(vipPhone, phone));
}

function saveVipClients(phones: any, filePath: any = DEFAULT_VIP_CLIENTS_PATH) {
  const content = phones.join(',');
  fs.writeFileSync(filePath, content, 'utf8');
}

function formatVipList(vipClients: any = loadVipClients()) {
  if (vipClients.length === 0) {
    return 'VIP-список пуст';
  }

  return ['VIP-клиенты:', ...vipClients.map((phone?: any, index?: any) => `${index + 1}. ${phone}`)].join('\n');
}

function addVipClient(phone: any, filePath: any = DEFAULT_VIP_CLIENTS_PATH) {
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

function removeVipClient(phone: any, filePath: any = DEFAULT_VIP_CLIENTS_PATH) {
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

export {
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
