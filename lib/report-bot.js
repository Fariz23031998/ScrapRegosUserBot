const { hasRight } = require('./user-rights');
const {
  getEarningsSummary,
  buildEarningsExcel,
  parseReportDate,
  parseReportDateRange,
  parseDateRangeBody,
  buildPeriodFromDates,
} = require('./earnings-report');

const REPORT_DENIED = 'Нет доступа к отчёту.';
const REPORT_EMPTY = 'За выбранный период операций не найдено.';
const REPORT_PROMPT_FROM =
  'Укажите дату начала периода в формате ДД.ММ.ГГГГ или ГГГГ-ММ-ДД.\n\nМожно сразу указать диапазон: ДД.ММ.ГГГГ - ДД.ММ.ГГГГ';
const REPORT_PROMPT_TO = 'Укажите дату окончания периода в формате ДД.ММ.ГГГГ или ГГГГ-ММ-ДД.';
const REPORT_INVALID_DATE = 'Неверная дата. Используйте формат ДД.ММ.ГГГГ или ГГГГ-ММ-ДД.';
const REPORT_INVALID_RANGE = 'Дата окончания не может быть раньше даты начала.';
const REPORT_CANCELLED = 'Формирование отчёта отменено.';

const pendingReports = new Map();

function cancelKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: 'Отмена', callback_data: 'report:cancel' }]],
    },
  };
}

function clearPending(telegramId) {
  pendingReports.delete(telegramId);
}

function getPending(telegramId) {
  return pendingReports.get(telegramId) ?? null;
}

function isCancelCommand(text) {
  const value = String(text || '').trim().toLowerCase();
  return value === '/cancel' || value === 'отмена' || value === 'cancel';
}

async function sendReport(bot, chatId, db, { scopeLabel, queryFilters, period, filenamePrefix }) {
  const summary = getEarningsSummary(db, queryFilters);
  if (!summary.count) {
    await bot.sendMessage(chatId, REPORT_EMPTY);
    return;
  }

  const text = [
    `Отчёт ${scopeLabel} за ${period.label}:`,
    `Операций: ${summary.count}`,
    `Итого: ${summary.total.toLocaleString('ru-RU')} UZS`,
  ].join('\n');

  await bot.sendMessage(chatId, text);

  const buffer = await buildEarningsExcel(summary.rows);
  const filename = `${filenamePrefix}-${period.label.replace(/\s+/g, '_')}.xlsx`;
  await bot.sendDocument(
    chatId,
    buffer,
    {},
    { filename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
  );
}

function getReportConfig(type, telegramId, period) {
  if (type === 'all') {
    return {
      scopeLabel: 'по всем сотрудникам',
      queryFilters: { from: period.from, to: period.to },
      filenamePrefix: 'reports',
    };
  }
  return {
    scopeLabel: 'по вам',
    queryFilters: { telegramId, from: period.from, to: period.to },
    filenamePrefix: 'report',
  };
}

async function deliverReport(bot, chatId, db, type, telegramId, period) {
  await sendReport(bot, chatId, db, {
    ...getReportConfig(type, telegramId, period),
    period,
  });
}

async function startReportFlow(bot, chatId, telegramId, type) {
  clearPending(telegramId);
  pendingReports.set(telegramId, { type, step: 'await_from' });
  await bot.sendMessage(chatId, REPORT_PROMPT_FROM, cancelKeyboard());
}

async function handleReportCommand(bot, msg, db, { type, right, command }) {
  const telegramId = msg.from.id;
  if (!hasRight(db, telegramId, right)) {
    await bot.sendMessage(msg.chat.id, REPORT_DENIED);
    return;
  }

  const period = parseReportDateRange(msg.text, command);
  if (period) {
    clearPending(telegramId);
    await deliverReport(bot, msg.chat.id, db, type, telegramId, period);
    return;
  }

  await startReportFlow(bot, msg.chat.id, telegramId, type);
}

function registerReportHandlers(bot, { db }) {
  bot.onText(/^\/report(?:@\w+)?(?:\s+.*)?$/i, async (msg) => {
    await handleReportCommand(bot, msg, db, {
      type: 'own',
      right: 'see_own_report',
      command: 'report',
    });
  });

  bot.onText(/^\/reports(?:@\w+)?(?:\s+.*)?$/i, async (msg) => {
    await handleReportCommand(bot, msg, db, {
      type: 'all',
      right: 'see_all_report',
      command: 'reports',
    });
  });

  bot.on('callback_query', async (query) => {
    if (query.data !== 'report:cancel') return;

    const telegramId = query.from.id;
    const chatId = query.message?.chat?.id;
    await bot.answerCallbackQuery(query.id);
    clearPending(telegramId);
    if (chatId) {
      await bot.sendMessage(chatId, REPORT_CANCELLED);
    }
  });
}

async function handleReportMessage(bot, msg, db) {
  const pending = getPending(msg.from.id);
  if (!pending) return false;

  const text = msg.text?.trim() || '';
  if (isCancelCommand(text)) {
    clearPending(msg.from.id);
    await bot.sendMessage(msg.chat.id, REPORT_CANCELLED);
    return true;
  }

  if (pending.step === 'await_from') {
    const inlineRange = parseDateRangeBody(text);
    if (inlineRange) {
      clearPending(msg.from.id);
      await deliverReport(bot, msg.chat.id, db, pending.type, msg.from.id, inlineRange);
      return true;
    }

    const fromDate = parseReportDate(text);
    if (!fromDate) {
      await bot.sendMessage(msg.chat.id, REPORT_INVALID_DATE, cancelKeyboard());
      return true;
    }

    pendingReports.set(msg.from.id, {
      type: pending.type,
      step: 'await_to',
      from: fromDate.iso,
    });
    await bot.sendMessage(msg.chat.id, REPORT_PROMPT_TO, cancelKeyboard());
    return true;
  }

  if (pending.step === 'await_to') {
    const toDate = parseReportDate(text);
    if (!toDate) {
      await bot.sendMessage(msg.chat.id, REPORT_INVALID_DATE, cancelKeyboard());
      return true;
    }
    if (toDate.iso < pending.from) {
      await bot.sendMessage(msg.chat.id, REPORT_INVALID_RANGE, cancelKeyboard());
      return true;
    }

    const period = buildPeriodFromDates(pending.from, toDate.iso);
    clearPending(msg.from.id);
    if (!period) {
      await bot.sendMessage(msg.chat.id, REPORT_INVALID_DATE);
      return true;
    }

    await deliverReport(bot, msg.chat.id, db, pending.type, msg.from.id, period);
    return true;
  }

  return false;
}

module.exports = {
  registerReportHandlers,
  handleReportMessage,
};
