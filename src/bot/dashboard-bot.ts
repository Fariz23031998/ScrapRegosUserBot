import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type TelegramBot from 'node-telegram-bot-api';
import { hasRight } from '../db/user-rights';
import { isLinkedEmployee } from '../db/bot-users-db';
import { getPublicBaseUrl } from '../payments/payments-api';
import { createDashboardLoginToken, TOKEN_TTL_MS } from '../admin/dashboard-login-tokens';
import { getAdminCredentials } from '../admin/bot-admin-auth';
import { sendChatActionSafe } from './telegram-safe';

const ACCESS_DENIED = 'Доступ запрещён. Нет права на открытие админ-панели.';
const NOT_CONFIGURED =
  'Админ-панель не настроена. Задайте BOT_ADMIN_LOGIN, BOT_ADMIN_PASSWORD и PUBLIC_BASE_URL.';
const LINK_SENT = 'Ссылка для входа в админ-панель:';

function buildDashboardWebAppUrl() {
  const base = getPublicBaseUrl();
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/bot-admin/`;
}

function buildDashboardLoginUrl(rawToken?: any) {
  const base = getPublicBaseUrl();
  if (!base || !rawToken) return null;
  return `${base.replace(/\/+$/, '')}/bot-admin/auth/telegram?token=${encodeURIComponent(rawToken)}`;
}

function checkDashboardAccess(db: Db, botUser?: any) {
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

function registerDashboardHandlers(bot: TelegramBot, { db, getBotUser, sendRegisterPrompt }: Unchecked) {
  bot.onText(/\/open[_-]dashboard(?:@\w+)?(?:\s|$)/, async (msg?: any) => {
    const telegramId = msg.from.id;
    const botUser = getBotUser(telegramId);
    const access = checkDashboardAccess(db, botUser);

    if (access.needsRegistration) {
      await sendRegisterPrompt(msg.chat.id);
      return;
    }
    if (!access.allowed) {
      await bot.sendMessage(msg.chat.id, access.message!);
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
    } catch (error: any) {
      console.error('Failed to create dashboard login link:', error.message);
      await bot.sendMessage(msg.chat.id, 'Не удалось создать ссылку. Попробуйте ещё раз.');
    }
  });
}

export {
  registerDashboardHandlers,
  checkDashboardAccess,
  buildDashboardLoginUrl,
  buildDashboardWebAppUrl,
  ACCESS_DENIED,
  NOT_CONFIGURED,
};
