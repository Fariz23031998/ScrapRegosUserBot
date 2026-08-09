const { getAllUnpaidOrders } = require('../db/partners-db');
const { getTechnicalSupportStatusByPhone } = require('../db/technical-support');
const { listLinksByClient } = require('../db/client-firm-links');
const { phonesMatch } = require('../bot/search-user');

function ticketClientId(ticket) {
  const id = Number(ticket?.client_id ?? ticket?.client?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function ticketClientPhone(ticket) {
  const phone = String(ticket?.client?.phone || '').trim();
  return phone || null;
}

function mapUnpaidOrderSummary(order) {
  return {
    id: order.id,
    amount: Number(order.amount) || 0,
    currency: order.currency || 'UZS',
    created_at: order.created_at || null,
    ticket_id: order.ticket_id ?? null,
    client_phone: order.client_phone || null,
  };
}

function summarizeUnpaidOrders(orders) {
  const list = (orders || []).map(mapUnpaidOrderSummary);
  const totalAmount = list.reduce((sum, order) => sum + (Number(order.amount) || 0), 0);
  return {
    count: list.length,
    total_amount: totalAmount,
    orders: list,
  };
}

function mapFirmLinkSummary(link) {
  return {
    id: link.id,
    firm_type: link.firm_type,
    firm_record_id: link.firm_record_id,
    firm_name: link.firm_name,
    firm_phone: link.firm_phone,
  };
}

function collectTicketPhones(clientPhone, firms) {
  const phones = [];
  const seen = new Set();
  for (const phone of [clientPhone, ...(firms || []).map((firm) => firm.firm_phone)]) {
    const value = String(phone || '').trim();
    if (!value) continue;
    const key = value.replace(/\D/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    phones.push(value);
  }
  return phones;
}

function orderMatchesAnyPhone(order, phones) {
  if (!phones.length) return false;
  return phones.some(
    (phone) =>
      phonesMatch(order.client_phone, phone) || phonesMatch(order.additional_phone, phone)
  );
}

const TS_RANK = { active: 2, expired: 1, none: 0 };

function pickBetterTsStatus(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;
  const currentRank = TS_RANK[current.status] || 0;
  const candidateRank = TS_RANK[candidate.status] || 0;
  if (candidateRank > currentRank) return candidate;
  if (candidateRank < currentRank) return current;
  const currentEnds = Date.parse(current.ends_at || '') || 0;
  const candidateEnds = Date.parse(candidate.ends_at || '') || 0;
  return candidateEnds > currentEnds ? candidate : current;
}

/**
 * Attach local SQLite context to a page of REGOS tickets.
 * Batches unpaid-order scan and caches TS / firm lookups per phone / client id.
 */
function enrichTicketsWithLocalData(db, tickets) {
  const rows = Array.isArray(tickets) ? tickets : [];
  if (rows.length === 0) return rows;

  const pendingOrders = getAllUnpaidOrders(db);
  const tsByPhone = new Map();
  const firmsByClientId = new Map();

  function tsForPhone(phone) {
    if (!phone) return { status: 'none', ends_at: null, starts_at: null };
    if (tsByPhone.has(phone)) return tsByPhone.get(phone);
    const status = getTechnicalSupportStatusByPhone(db, phone);
    const compact = {
      status: status.status,
      ends_at: status.ends_at,
      starts_at: status.starts_at,
    };
    tsByPhone.set(phone, compact);
    return compact;
  }

  function firmsForClient(clientId) {
    if (!clientId) return [];
    if (firmsByClientId.has(clientId)) return firmsByClientId.get(clientId);
    const firms = listLinksByClient(db, clientId).map(mapFirmLinkSummary);
    firmsByClientId.set(clientId, firms);
    return firms;
  }

  return rows.map((ticket) => {
    const phone = ticketClientPhone(ticket);
    const clientId = ticketClientId(ticket);
    const firms = firmsForClient(clientId);
    const phones = collectTicketPhones(phone, firms);
    const matchedOrders = phones.length
      ? pendingOrders.filter((order) => orderMatchesAnyPhone(order, phones))
      : [];
    const technicalSupport = phones.reduce(
      (best, candidatePhone) => pickBetterTsStatus(best, tsForPhone(candidatePhone)),
      { status: 'none', ends_at: null, starts_at: null }
    );

    return {
      ...ticket,
      local: {
        unpaid_orders: summarizeUnpaidOrders(matchedOrders),
        technical_support: technicalSupport,
        firms,
      },
    };
  });
}

module.exports = {
  enrichTicketsWithLocalData,
  summarizeUnpaidOrders,
  collectTicketPhones,
  ticketClientId,
  ticketClientPhone,
};
