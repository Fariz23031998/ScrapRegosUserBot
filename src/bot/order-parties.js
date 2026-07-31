const { getBotUserByTelegramId, findUserByPhone } = require('../db/bot-users-db');

function parseOrderMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function getUserDisplayName(user) {
  if (!user) return null;
  return (
    String(user.display_name || '').trim() ||
    [user.first_name, user.last_name].filter(Boolean).join(' ').trim() ||
    (user.username ? `@${String(user.username).replace(/^@/, '')}` : null)
  );
}

function formatTelegramPhone(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/\D/g, '');
  const uzbek = /^(?:998)?(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(digits);
  if (uzbek) {
    const [, code, first, second, third] = uzbek;
    return `+998 (${code}) ${first}-${second}-${third}`;
  }
  return raw || '—';
}

function enrichOrderParties(db, order) {
  if (!order) return order;
  const metadata = parseOrderMetadata(order.metadata);
  const employee = getBotUserByTelegramId(db, order.telegram_id);
  const customer = findUserByPhone(db, order.client_phone);

  return {
    ...order,
    employee_name: getUserDisplayName(employee),
    employee_phone: employee?.phone || order.bot_user_phone || null,
    customer_name: String(metadata.clientName || '').trim() || getUserDisplayName(customer),
    customer_phone: customer?.phone || order.client_phone || null,
  };
}

function formatPerson(name, phone) {
  const displayName = String(name || '').trim() || 'Имя не указано';
  return `${displayName} - ${formatTelegramPhone(phone)}`;
}

function formatOrderPartyLines(order) {
  const lines = [
    `Сотрудник: ${formatPerson(order.employee_name, order.employee_phone || order.bot_user_phone)}`,
    `Клиент: ${formatPerson(order.customer_name, order.customer_phone || order.client_phone)}`,
  ];
  const additionalPhone = String(order.additional_phone || '').trim();
  if (additionalPhone) {
    lines.push(`Доп. номер: ${formatTelegramPhone(additionalPhone)}`);
  }
  return lines;
}

module.exports = {
  parseOrderMetadata,
  getUserDisplayName,
  formatTelegramPhone,
  enrichOrderParties,
  formatPerson,
  formatOrderPartyLines,
};
