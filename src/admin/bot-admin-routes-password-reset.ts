import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { findEmployeeByAdminLogin, getEmployeeByPhone, normalizePhoneKey, updateEmployeeUser } from '../db/bot-users-db';
import { buildAuditDetails } from '../db/admin-audit-logs';
import { getOutboundBot } from '../bot/payment-notification';
import { getAdminCredentials } from './bot-admin-auth';
import { auditAdminChange } from './bot-admin-shared';
import { discardPasswordResetCode, issuePasswordResetCode, consumePasswordResetCode } from './password-reset-codes';

const MIN_PHONE_DIGITS = 9;
const PASSWORD_RESET_REQUEST_MESSAGE =
  'Если логин или телефон привязан к боту, код отправлен в Telegram.';
const PASSWORD_RESET_CONFIRM_ERROR = 'Неверный или просроченный код.';
const PASSWORD_RESET_CONFIRM_MESSAGE = 'Пароль сохранён. Теперь можно войти.';

type PasswordResetSender = (telegramId: unknown, text: string) => Promise<unknown>;

let senderOverride: PasswordResetSender | undefined;

function setPasswordResetSender(sender?: PasswordResetSender) {
  senderOverride = sender;
}

function looksLikePhone(identifier: string) {
  const compact = identifier.replace(/[\s()-]/g, '');
  if (!/^\+?\d+$/.test(compact)) return false;
  return normalizePhoneKey(compact).length >= MIN_PHONE_DIGITS;
}

function findEmployeeForPasswordReset(db: Db, identifier: string) {
  const byLogin = findEmployeeByAdminLogin(db, identifier);
  if (byLogin) return byLogin;
  if (!looksLikePhone(identifier)) return null;
  return getEmployeeByPhone(db, identifier);
}

function formatPasswordResetMessage(login: string | null, phone: string | null, code: string) {
  const identity = login ? `Логин: ${login}` : `Телефон: ${phone || ''}`;
  return [
    'Код для пароля в панели Bot Admin.',
    identity,
    `Код: ${code}`,
    'Код действует 10 минут. Если вы не запрашивали смену пароля, проигнорируйте это сообщение.',
  ].join('\n');
}

async function deliverPasswordResetCode(telegramId: unknown, text: string) {
  try {
    if (senderOverride) {
      await senderOverride(telegramId, text);
      return true;
    }

    const bot = getOutboundBot();
    if (!bot) {
      console.warn('[password-reset] TELEGRAM_BOT_TOKEN not set — skipping code.');
      return false;
    }

    const chatId = typeof telegramId === 'bigint' ? telegramId.toString() : (telegramId as string | number);
    await bot.sendMessage(chatId, text);
    return true;
  } catch (error: any) {
    console.error('[password-reset] Failed to send code:', error?.message || error);
    return false;
  }
}

export function registerBotAdminPasswordResetRoutes(router: any, deps: { db: Db }) {
  const { db } = deps;

  router.post('/api/password-reset/request', express.json(), async (req: Request, res: Response) => {
    const login = String(req.body?.login || req.body?.phone || '').trim();
    if (!login) {
      return res.status(400).json({ message: 'Укажите логин или телефон.' });
    }

    const body = { ok: true, message: PASSWORD_RESET_REQUEST_MESSAGE };
    try {
      const creds = getAdminCredentials();
      if (creds && login === creds.login) {
        return res.json(body);
      }

      const employee = findEmployeeForPasswordReset(db, login);
      if (!employee || employee.telegram_id == null) {
        return res.json(body);
      }

      const issued = issuePasswordResetCode(db, Number(employee.id));
      if (!issued.issued) {
        return res.json(body);
      }

      const delivered = await deliverPasswordResetCode(
        employee.telegram_id,
        formatPasswordResetMessage(employee.admin_login ? String(employee.admin_login) : null, employee.phone ? String(employee.phone) : null, issued.code)
      );
      if (!delivered) {
        discardPasswordResetCode(db, issued.id);
      }
      return res.json(body);
    } catch (error: any) {
      console.error('[password-reset] Request failed:', error?.message || error);
      return res.status(500).json({ message: 'Не удалось отправить код. Попробуйте ещё раз.' });
    }
  });

  router.post('/api/password-reset/confirm', express.json(), (req: Request, res: Response) => {
    const login = String(req.body?.login || req.body?.phone || '').trim();
    const code = String(req.body?.code ?? '').trim();
    const password = String(req.body?.password ?? '');

    if (!login || !code) {
      return res.status(400).json({ message: 'Укажите логин или телефон и код.' });
    }
    if (!password) {
      return res.status(400).json({ message: 'Укажите пароль.' });
    }

    const invalid = () => res.status(400).json({ message: PASSWORD_RESET_CONFIRM_ERROR });

    try {
      const creds = getAdminCredentials();
      if (creds && login === creds.login) {
        return invalid();
      }

      const employee = findEmployeeForPasswordReset(db, login);
      if (!employee || !consumePasswordResetCode(db, Number(employee.id), code)) {
        return invalid();
      }

      if (!employee.admin_login) {
        return res.status(400).json({
          message: 'Для этого сотрудника не задан логин панели. Обратитесь к администратору.',
        });
      }

      updateEmployeeUser(db, employee.id, { password });
      auditAdminChange(db, req, {
        entityType: 'user',
        entityId: employee.id,
        action: 'update',
        summary: 'Пароль задан по коду из Telegram',
        details: buildAuditDetails({
          before: { password: employee.password_hash ? '[задано]' : null },
          after: { password: '[задано]' },
        }),
      });

      return res.json({ ok: true, message: PASSWORD_RESET_CONFIRM_MESSAGE });
    } catch (error: any) {
      console.error('[password-reset] Confirm failed:', error?.message || error);
      return res.status(500).json({ message: 'Не удалось сохранить пароль.' });
    }
  });
}

export {
  PASSWORD_RESET_REQUEST_MESSAGE,
  PASSWORD_RESET_CONFIRM_ERROR,
  PASSWORD_RESET_CONFIRM_MESSAGE,
  setPasswordResetSender,
  formatPasswordResetMessage,
};
