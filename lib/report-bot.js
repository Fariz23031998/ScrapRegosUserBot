const { hasRight } = require('./user-rights');
const { getEarningsSummary, buildEarningsExcel, parseReportPeriod } = require('./earnings-report');

const REPORT_DENIED = 'Нет доступа к отчёту.';
const REPORT_EMPTY = 'За выбранный период операций не найдено.';

async function sendReport(bot, chatId, db, { scopeLabel, queryFilters, period, filenamePrefix }) {
  const summary = getEarningsSummary(db, queryFilters);
  if (!summary.count) {
    await bot.sendMessage(chatId, REPORT_EMPTY);
    return;
  }

  const periodLabel = period ? ` за ${period.label}` : '';
  const text = [
    `Отчёт ${scopeLabel}${periodLabel}:`,
    `Операций: ${summary.count}`,
    `Итого: ${summary.total.toLocaleString('ru-RU')} UZS`,
  ].join('\n');

  await bot.sendMessage(chatId, text);

  const buffer = await buildEarningsExcel(summary.rows);
  const filename = `${filenamePrefix}${period ? `-${period.label}` : ''}.xlsx`;
  await bot.sendDocument(
    chatId,
    buffer,
    {},
    { filename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
  );
}

function registerReportHandlers(bot, { db }) {
  bot.onText(/^\/report(?:@\w+)?(?:\s+\d{4}-\d{2})?$/i, async (msg) => {
    const telegramId = msg.from.id;
    if (!hasRight(db, telegramId, 'see_own_report')) {
      await bot.sendMessage(msg.chat.id, REPORT_DENIED);
      return;
    }

    const period = parseReportPeriod(msg.text, 'report');
    const queryFilters = { telegramId };
    if (period) {
      queryFilters.from = period.from;
      queryFilters.to = period.to;
    }

    await sendReport(bot, msg.chat.id, db, {
      scopeLabel: 'по вам',
      queryFilters,
      period,
      filenamePrefix: 'report',
    });
  });

  bot.onText(/^\/reports(?:@\w+)?(?:\s+\d{4}-\d{2})?$/i, async (msg) => {
    const telegramId = msg.from.id;
    if (!hasRight(db, telegramId, 'see_all_report')) {
      await bot.sendMessage(msg.chat.id, REPORT_DENIED);
      return;
    }

    const period = parseReportPeriod(msg.text, 'reports');
    const queryFilters = {};
    if (period) {
      queryFilters.from = period.from;
      queryFilters.to = period.to;
    }

    await sendReport(bot, msg.chat.id, db, {
      scopeLabel: 'по всем сотрудникам',
      queryFilters,
      period,
      filenamePrefix: 'reports',
    });
  });
}

module.exports = {
  registerReportHandlers,
};
