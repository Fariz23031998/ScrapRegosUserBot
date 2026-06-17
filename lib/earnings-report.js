const ExcelJS = require('exceljs');
const { getEarningsRows } = require('./bot-users-db');

const EXCEL_COLUMNS = [
  { header: 'Дата оплаты', key: 'paid_at', width: 20 },
  { header: 'ID заказа', key: 'order_id', width: 38 },
  { header: 'Сумма', key: 'amount', width: 14 },
  { header: 'Валюта', key: 'currency', width: 10 },
  { header: 'Провайдер', key: 'provider', width: 12 },
  { header: 'Телефон клиента', key: 'client_phone', width: 18 },
  { header: 'Сотрудник', key: 'employee_name', width: 20 },
  { header: 'Телефон сотрудника', key: 'employee_phone', width: 18 },
];

function getEarningsSummary(db, filters = {}) {
  const rows = getEarningsRows(db, filters);
  const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  return { total, count: rows.length, rows };
}

async function buildEarningsExcel(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Операции');
  sheet.columns = EXCEL_COLUMNS;
  for (const row of rows) {
    sheet.addRow({
      paid_at: row.paid_at,
      order_id: row.order_id,
      amount: row.amount,
      currency: row.currency || 'UZS',
      provider: row.provider,
      client_phone: row.client_phone,
      employee_name: row.employee_name,
      employee_phone: row.employee_phone,
    });
  }
  sheet.getRow(1).font = { bold: true };
  return workbook.xlsx.writeBuffer();
}

function parseReportDate(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  let match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return buildReportDate(match[1], match[2], match[3]);
  }

  match = trimmed.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (match) {
    return buildReportDate(match[3], match[2], match[1]);
  }

  return null;
}

function buildReportDate(yearText, monthText, dayText) {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const label = `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${year}`;
  return { iso, label };
}

function parseReportPeriod(text, command = 'report') {
  const match = String(text || '')
    .trim()
    .match(new RegExp(`^\\/${command}(?:@\\w+)?\\s+(\\d{4}-\\d{2})$`, 'i'));
  if (!match) return null;
  const [year, month] = match[1].split('-').map(Number);
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { from, to, label: match[1] };
}

function parseDateRangeBody(body) {
  const parts = String(body || '')
    .trim()
    .split(/\s+[-–—]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length !== 2) return null;

  const fromDate = parseReportDate(parts[0]);
  const toDate = parseReportDate(parts[1]);
  if (!fromDate || !toDate || fromDate.iso > toDate.iso) {
    return null;
  }

  return {
    from: fromDate.iso,
    to: toDate.iso,
    label: `${fromDate.label} — ${toDate.label}`,
  };
}

function parseReportDateRange(text, command = 'report') {
  const monthPeriod = parseReportPeriod(text, command);
  if (monthPeriod) return monthPeriod;

  const commandMatch = String(text || '')
    .trim()
    .match(new RegExp(`^\\/${command}(?:@\\w+)?\\s+(.+)$`, 'i'));
  const body = commandMatch ? commandMatch[1] : '';
  if (!body) return null;

  return parseDateRangeBody(body);
}

function buildPeriodFromDates(fromIso, toIso) {
  const fromDate = parseReportDate(fromIso);
  const toDate = parseReportDate(toIso);
  if (!fromDate || !toDate) return null;
  return {
    from: fromDate.iso,
    to: toDate.iso,
    label: `${fromDate.label} — ${toDate.label}`,
  };
}

module.exports = {
  getEarningsSummary,
  buildEarningsExcel,
  parseReportDate,
  parseReportPeriod,
  parseReportDateRange,
  parseDateRangeBody,
  buildPeriodFromDates,
};
