const { field, link } = require('./telegram-html');

function getPublicBaseUrl() {
  const raw = String(process.env.PUBLIC_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (!raw) return '';
  return raw.replace(/^(https?):(?!\/\/)/i, '$1://');
}

function formatTicketAdminUrl(ticketId) {
  const base = getPublicBaseUrl();
  if (!base || ticketId == null || ticketId === '') return null;
  const id = Number(ticketId);
  if (!Number.isFinite(id)) return null;
  return `${base}/bot-admin/tickets/${id}`;
}

function formatOrderTicketLine(order) {
  const ticketId = order?.ticket_id;
  if (ticketId == null || ticketId === '') return null;
  const url = formatTicketAdminUrl(ticketId);
  if (url) {
    return `🎫 ${link(url, `Тикет #${ticketId}`)}`;
  }
  return field('🎫', 'Тикет', `#${ticketId}`);
}

module.exports = {
  formatTicketAdminUrl,
  formatOrderTicketLine,
};
