const { SUMMARY_CHARS_PER_TOKEN, SUMMARY_TOKEN_BUDGET } = require('./settings');

function toUnixSeconds(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) {
    return num > 1e12 ? Math.floor(num / 1000) : Math.floor(num);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function nowUnixSeconds(now = Date.now()) {
  const value = Number(now);
  if (!Number.isFinite(value) || value <= 0) return Math.floor(Date.now() / 1000);
  return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
}

function resolveTicketClientId(ticket) {
  const id = Number(ticket?.client_id ?? ticket?.client?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function resolveTicketMessagePeriod(ticket, { now, occurredAt } = {}) {
  const from = toUnixSeconds(ticket?.created_date) || 0;
  const to =
    toUnixSeconds(ticket?.resolved_date) ||
    toUnixSeconds(occurredAt) ||
    nowUnixSeconds(now);
  return { from, to: to >= from ? to : from };
}

function isRegularChatMessage(message) {
  return String(message?.message_type || 'Regular') === 'Regular';
}

function isMessageInTicketPeriod(message, { from = 0, to = null } = {}) {
  const created = toUnixSeconds(message?.created_date);
  if (created == null) return !from;
  if (from && created < from) return false;
  if (to != null && created > to) return false;
  return true;
}

function filterMessagesInTicketPeriod(messages, period) {
  return (messages || []).filter((item) => isMessageInTicketPeriod(item, period));
}

function sortChatMessagesAscending(messages) {
  return [...(messages || [])]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const dateA = Number(a.item?.created_date) || 0;
      const dateB = Number(b.item?.created_date) || 0;
      if (dateA !== dateB) return dateA - dateB;
      const idA = Number(a.item?.id);
      const idB = Number(b.item?.id);
      if (Number.isFinite(idA) && Number.isFinite(idB) && idA !== idB) return idA - idB;
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / SUMMARY_CHARS_PER_TOKEN);
}

function truncateToTokens(text, maxTokens) {
  const value = String(text || '');
  const maxChars = Math.max(0, Math.floor(Number(maxTokens) || 0) * SUMMARY_CHARS_PER_TOKEN);
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return '…';
  return `${value.slice(0, maxChars - 1)}…`;
}

function formatSummaryLine(item, text) {
  const id = item?.ticket_id != null ? `#${item.ticket_id}` : 'предыдущее обращение';
  return `${id}: ${text}`;
}

function formatPriorSummariesForPrompt(summaries, { systemText = '', budgetTokens = SUMMARY_TOKEN_BUDGET } = {}) {
  const reserved = estimateTokens(systemText);
  let remaining = Math.max(0, Number(budgetTokens) || 0) - reserved;
  if (remaining <= 8) return '';

  const header = 'Сводки предыдущих обращений этого клиента:';
  remaining -= estimateTokens(`${header}\n`);
  if (remaining <= 8) return '';

  const selected = [];
  for (const item of summaries || []) {
    const text = String(item?.summary || '').trim();
    if (!text) continue;
    const block = formatSummaryLine(item, text);
    const tokens = estimateTokens(block);
    if (tokens <= remaining) {
      selected.push(block);
      remaining -= tokens;
      continue;
    }
    if (remaining > 8) {
      selected.push(truncateToTokens(block, remaining));
    }
    break;
  }
  if (!selected.length) return '';
  return `${header}\n${selected.join('\n\n')}`;
}

function appendPriorTicketSummaries(system, summaries, { budgetTokens = SUMMARY_TOKEN_BUDGET } = {}) {
  const base = String(system || '').trim();
  const block = formatPriorSummariesForPrompt(summaries, { systemText: base, budgetTokens });
  return [base, block].filter(Boolean).join('\n\n');
}

async function fetchChatMessagesInPeriod(chatId, options = {}) {
  const id = String(chatId || '').trim();
  if (!id) return [];

  const from = Number(options.from) || 0;
  const to = options.to == null ? null : Number(options.to);
  const stopAfter = options.stopAfter == null ? null : Number(options.stopAfter);
  const pageSize = Math.min(100, Math.max(1, Number(options.pageSize) || 100));
  const getPage =
    options.getTicketMessages || require('../integrations/regos-crm').getTicketMessages;

  const collected = [];
  const seen = new Set();
  let offset = 0;
  let limit =
    stopAfter != null && Number.isInteger(stopAfter) && stopAfter > 0
      ? Math.min(100, stopAfter)
      : pageSize;

  for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
    const page = await getPage(id, { limit, offset });
    const rows = page?.result || [];
    const total = Number(page?.total);

    for (const item of rows) {
      const key = String(item?.id ?? '');
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      if (isMessageInTicketPeriod(item, { from, to })) {
        collected.push(item);
      }
    }

    let oldest = null;
    for (const item of rows) {
      const created = toUnixSeconds(item?.created_date);
      if (created == null) continue;
      oldest = oldest == null ? created : Math.min(oldest, created);
    }

    const regularCount = collected.filter(isRegularChatMessage).length;
    const enough = stopAfter != null && regularCount >= stopAfter;
    const reachedStart = rows.length === 0 || (from > 0 && oldest != null && oldest < from);
    const exhausted =
      rows.length === 0 || (Number.isFinite(total) && offset + rows.length >= total);

    if (enough || reachedStart || exhausted) break;
    offset = page.next_offset ?? offset + rows.length;
    limit = pageSize;
  }

  return sortChatMessagesAscending(collected);
}

module.exports = {
  toUnixSeconds,
  nowUnixSeconds,
  resolveTicketClientId,
  resolveTicketMessagePeriod,
  isRegularChatMessage,
  isMessageInTicketPeriod,
  filterMessagesInTicketPeriod,
  sortChatMessagesAscending,
  estimateTokens,
  truncateToTokens,
  formatPriorSummariesForPrompt,
  appendPriorTicketSummaries,
  fetchChatMessagesInPeriod,
};
