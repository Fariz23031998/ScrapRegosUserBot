const crypto = require('crypto');
const { isLinkedEmployee } = require('../db/bot-users-db');
const { liveGetPartnerAccountDetail } = require('../live/portal-search');
const {
  getRegosPriceCatalog,
  calculateTariffMonthlyTotal,
} = require('../sync/regos-price-page');
const { answerCallbackQuerySafe, onCallbackQuery, sendChatActionSafe } = require('./telegram-safe');
const { bold, field, withHtml } = require('./telegram-html');

const DRAFT_TTL_MS = 30 * 60 * 1000;
const ACCESS_DENIED = 'Сначала пройдите регистрацию: отправьте свой номер телефона.';
const STALE_LINK = 'Ссылка устарела. Выполните поиск заново.';
const WRONG_USER = 'Эта кнопка доступна только пользователю, который выполнил поиск.';
const LOAD_FAILED = 'Не удалось загрузить информацию о тарифе. Попробуйте позже.';

const tariffDrafts = new Map();

function generateToken() {
  return crypto.randomBytes(4).toString('hex');
}

function cleanupOldDrafts() {
  const now = Date.now();
  for (const [token, draft] of tariffDrafts.entries()) {
    if (draft.expiresAt <= now) {
      tariffDrafts.delete(token);
    }
  }
}

function createTariffInfoToken(result, telegramId) {
  if (!result?.accountId) return null;
  cleanupOldDrafts();
  const token = generateToken();
  tariffDrafts.set(token, {
    telegramId,
    accountId: result.accountId,
    accountLabel: result.accountLabel || null,
    apiLogin: result.apiLogin || null,
    tariff: result.tariff || null,
    expiresAt: Date.now() + DRAFT_TTL_MS,
  });
  return token;
}

function formatAmountUz(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '-');
  return `${Math.round(n).toLocaleString('ru-RU')} сум`;
}

function formatLimitLine(limit) {
  const parts = [];
  if (limit.totalRaw != null || limit.total != null) {
    parts.push(`Всего: ${limit.totalRaw ?? limit.total}`);
  }
  if (limit.includedRaw != null || limit.included != null) {
    parts.push(`По тарифу: ${limit.includedRaw ?? limit.included}`);
  }
  if (limit.actualRaw != null || limit.actual != null) {
    parts.push(`Фактически: ${limit.actualRaw ?? limit.actual}`);
  }
  return `• ${limit.name}: ${parts.join(' / ') || '-'}`;
}

function formatTariffInfoMessage(overview, calc, { apiLogin = null } = {}) {
  const lines = [`📦 ${bold('О тарифе')}`];
  if (apiLogin) {
    lines.push(field('🔑', 'API-логин', apiLogin));
  }
  if (overview.tariff) {
    lines.push(field('📦', 'Тариф', overview.tariff));
  }
  lines.push(field('✅', 'Статус', overview.status || '-'));
  lines.push(field('📊', 'Используемый лимит', overview.usedLimit || '-'));
  lines.push(field('💰', 'Стоимость тарифа', overview.tariffCost || '-'));

  lines.push('');
  lines.push(`📐 ${bold('Лимиты тарифа')}`);
  if (overview.limits?.length) {
    for (const limit of overview.limits) {
      lines.push(formatLimitLine(limit));
    }
  } else {
    lines.push('• —');
  }

  lines.push('');
  if (calc?.ok) {
    lines.push(field('🧮', 'Расчётная стоимость (прайс ROFEEV)', `${formatAmountUz(calc.total)}/мес`));
    if (calc.lines?.length > 1) {
      for (const line of calc.lines) {
        if (line.key === 'base') {
          lines.push(`  • ${line.label}: ${formatAmountUz(line.amount)}`);
        } else {
          lines.push(
            `  • ${line.label} × ${line.quantity}: ${formatAmountUz(line.amount)}`
          );
        }
      }
    }
  } else {
    lines.push(field('🧮', 'Расчётная стоимость (прайс ROFEEV)', 'не удалось рассчитать'));
  }

  return lines.join('\n');
}

async function buildTariffInfoReply(draft) {
  const [overview, catalog] = await Promise.all([
    liveGetPartnerAccountDetail(draft.accountId, draft.accountLabel),
    getRegosPriceCatalog(),
  ]);

  const tariffName = overview.tariff || draft.tariff || null;
  const calc = calculateTariffMonthlyTotal(
    { tariffName, limits: overview.limits || [] },
    catalog
  );

  return formatTariffInfoMessage(overview, calc, {
    apiLogin: draft.apiLogin || null,
  });
}

function registerTariffInfoHandlers(bot, { getBotUser }) {
  onCallbackQuery(bot, 'tariff info', async (query) => {
    const data = query.data || '';
    if (!data.startsWith('tariff:info:')) return;

    const chatId = query.message?.chat?.id;
    const telegramId = query.from.id;
    const botUser = getBotUser(telegramId);
    await answerCallbackQuerySafe(bot, query.id);

    if (!botUser || !isLinkedEmployee(botUser)) {
      await bot.sendMessage(chatId, ACCESS_DENIED);
      return;
    }

    const token = data.slice('tariff:info:'.length);
    cleanupOldDrafts();
    const draft = tariffDrafts.get(token);
    if (!draft || draft.expiresAt <= Date.now()) {
      tariffDrafts.delete(token);
      await bot.sendMessage(chatId, STALE_LINK);
      return;
    }
    if (draft.telegramId !== telegramId) {
      await bot.sendMessage(chatId, WRONG_USER);
      return;
    }

    await sendChatActionSafe(bot, chatId);
    try {
      const text = await buildTariffInfoReply(draft);
      await bot.sendMessage(chatId, text, withHtml());
    } catch (err) {
      console.error('[tariff-info] failed:', err.message || err);
      await bot.sendMessage(chatId, LOAD_FAILED);
    }
  });
}

module.exports = {
  createTariffInfoToken,
  formatTariffInfoMessage,
  formatAmountUz,
  registerTariffInfoHandlers,
  buildTariffInfoReply,
};
