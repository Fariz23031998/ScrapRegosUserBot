const ORDER_DATETIME_TIME_ZONE = 'Asia/Tashkent';
const { field } = require('./telegram-html');

function parseSqliteUtcDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)
    ? raw
    : `${raw.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatOrderDateTimeValue(value) {
  const date = parseSqliteUtcDate(value);
  if (!date) return null;

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ORDER_DATETIME_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const byType = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  return `${byType.day}.${byType.month}.${byType.year} ${byType.hour}:${byType.minute}`;
}

function formatOrderDateTimeLine(orderOrCreatedAt) {
  const value =
    orderOrCreatedAt && typeof orderOrCreatedAt === 'object'
      ? orderOrCreatedAt.created_at
      : orderOrCreatedAt;
  const formatted = formatOrderDateTimeValue(value);
  return formatted ? field('📅', 'Дата заказа', formatted) : null;
}

module.exports = {
  formatOrderDateTimeValue,
  formatOrderDateTimeLine,
};
