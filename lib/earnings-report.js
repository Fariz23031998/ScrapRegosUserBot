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

module.exports = {
  getEarningsSummary,
  buildEarningsExcel,
  parseReportPeriod,
};
