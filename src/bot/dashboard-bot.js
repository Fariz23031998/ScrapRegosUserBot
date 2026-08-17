const { hasRight } = require('../db/user-rights');
const { isLinkedEmployee } = require('../db/bot-users-db');
const { getPublicBaseUrl } = require('../payments/payments-api');
const {
  createDashboardLoginToken,
  TOKEN_TTL_MS,
} = require('../admin/dashboard-login-tokens');
const { getAdminCredentials } = require('../admin/bot-admin-auth');
const { sendChatActionSafe } = require('./telegram-safe');

const ACCESS_DENIED = 'Доступ запрещён. Нет права на открытие админ-панели.';
const NOT_CONFIGURED =
  'Админ-панель не настроена. Задайте BOT_ADMIN_LOGIN, BOT_ADMIN_PASSWORD и PUBLIC_BASE_URL.';
const LINK_SENT = 'Ссылка для входа в админ-панель:';

function buildDashboardWebAppUrl() {
  const base = getPublicBaseUrl();
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/bot-admin/`;
}

function buildDashboardLoginUrl(rawToken) {
  const base = getPublicBaseUrl();
  if (!base || !rawToken) return null;
  return `${base.replace(/\/+$/, '')}/bot-admin/auth/telegram?token=${encodeURIComponent(rawToken)}`;
}

function checkDashboardAccess(db, botUser) {
  if (!botUser) {
    return { allowed: false, message: null, needsRegistration: true };
  }
  if (!isLinkedEmployee(botUser)) {
    return { allowed: false, message: ACCESS_DENIED };
  }
  if (!hasRight(db, botUser.telegram_id, 'open_admin_dashboard')) {
    return { allowed: false, message: ACCESS_DENIED };
  }
  return { allowed: true };
}

function registerDashboardHandlers(bot, { db, getBotUser, sendRegisterPrompt }) {
  bot.onText(/\/open[_-]dashboard(?:@\w+)?(?:\s|$)/, async (msg) => {
    const telegramId = msg.from.id;
    const botUser = getBotUser(telegramId);
    const access = checkDashboardAccess(db, botUser);

    if (access.needsRegistration) {
      await sendRegisterPrompt(msg.chat.id);
      return;
    }
    if (!access.allowed) {
      await bot.sendMessage(msg.chat.id, access.message);
      return;
    }

    if (!getAdminCredentials() || !getPublicBaseUrl()) {
      await bot.sendMessage(msg.chat.id, NOT_CONFIGURED);
      return;
    }

    try {
      await sendChatActionSafe(bot, msg.chat.id);
      const { rawToken } = createDashboardLoginToken(db, telegramId);
      const url = buildDashboardLoginUrl(rawToken);
      const webAppUrl = buildDashboardWebAppUrl();
      if (!url || !webAppUrl) {
        await bot.sendMessage(msg.chat.id, NOT_CONFIGURED);
        return;
      }

      const ttlMinutes = Math.max(1, Math.round(TOKEN_TTL_MS / 60000));
      await bot.sendMessage(
        msg.chat.id,
        `${LINK_SENT}\nMini App открывается без одноразовой ссылки. Браузерная ссылка: первое открытие — в течение ${ttlMinutes} мин; пока сессия активна, той же ссылкой можно снова открыть панель.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Open in Telegram', web_app: { url: webAppUrl } }],
              [{ text: 'Open Admin Dashboard', url }],
            ],
          },
        }
      );
    } catch (error) {
      console.error('Failed to create dashboard login link:', error.message);
      await bot.sendMessage(msg.chat.id, 'Не удалось создать ссылку. Попробуйте ещё раз.');
    }
  });
}

module.exports = {
  registerDashboardHandlers,
  checkDashboardAccess,
  buildDashboardLoginUrl,
  buildDashboardWebAppUrl,
  ACCESS_DENIED,
  NOT_CONFIGURED,
};
