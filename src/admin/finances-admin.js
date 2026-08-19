const express = require('express');
const { getSessionActor, requireRight } = require('./bot-admin-auth');
const { getBotUserById, getBotUserByTelegramId } = require('../db/bot-users-db');
const { listAccounts, getAccount } = require('../db/accounts');
const {
  listAccountPayments,
  getAccountPayment,
  createAccountPayment,
  deleteAccountPayment,
} = require('../db/account-payments');

function paymentWriteErrorMessage(code) {
  const messages = {
    INVALID_ACCOUNT_PAYMENT_ACCOUNT: 'Выберите счёт.',
    INVALID_ACCOUNT_PAYMENT_DIRECTION: 'Тип платежа: приход или расход.',
    INVALID_ACCOUNT_PAYMENT_AMOUNT: 'Укажите сумму больше 0.',
    INVALID_ACCOUNT_PAYMENT_CURRENCY: 'Валюта платежа: UZS или USD.',
    INVALID_ACCOUNT_PAYMENT_NOTE: 'Слишком длинный комментарий к платежу.',
  };
  return messages[code] || null;
}

function respondWriteError(res, error, fallbackMessage) {
  if (error.message === 'NOT_FOUND') {
    return res.status(404).json({ message: fallbackMessage });
  }
  const mapped = paymentWriteErrorMessage(error.message);
  if (mapped) {
    return res.status(400).json({ message: mapped });
  }
  console.error(fallbackMessage, error);
  return res.status(500).json({ message: fallbackMessage });
}

function sessionUserId(db, req) {
  const actor = getSessionActor(req);
  if (actor?.type === 'telegram') return getBotUserByTelegramId(db, actor.telegramId)?.id ?? null;
  if (actor?.type === 'user') return getBotUserById(db, actor.userId)?.id ?? null;
  return null;
}

function registerFinancesRoutes(router, db, { auditAdminChange, buildAuditDetails }) {
  router.get('/api/finances/accounts', requireRight(db, 'finances_read'), (_req, res) => {
    try {
      return res.json({ accounts: listAccounts(db) });
    } catch (error) {
      console.error('List finance accounts error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить счета.' });
    }
  });

  router.get('/api/finances/payments', requireRight(db, 'finances_read'), (req, res) => {
    try {
      const payments = listAccountPayments(db, {
        account_id: req.query.account_id,
        direction: req.query.direction,
      });
      return res.json({ payments });
    } catch (error) {
      return respondWriteError(res, error, 'Не удалось загрузить платежи.');
    }
  });

  router.post('/api/finances/payments', requireRight(db, 'finances_create'), express.json(), (req, res) => {
    try {
      const payment = createAccountPayment(db, {
        account_id: req.body?.account_id,
        direction: req.body?.direction,
        amount: req.body?.amount,
        currency: req.body?.currency,
        note: req.body?.note,
        created_by_user_id: sessionUserId(db, req),
      });
      const account = getAccount(db, payment.account_id);
      const label = payment.direction === 'out' ? 'Расход' : 'Приход';
      auditAdminChange(db, req, {
        entityType: 'account_payment',
        entityId: payment.id,
        action: 'create',
        summary: `${label} ${payment.amount} ${payment.currency} по счёту «${account?.name || payment.account_id}»`,
        details: buildAuditDetails({ before: null, after: payment }),
      });
      return res.status(201).json({ payment, account });
    } catch (error) {
      return respondWriteError(res, error, 'Не удалось создать платёж.');
    }
  });

  router.delete('/api/finances/payments/:id', requireRight(db, 'finances_delete'), (req, res) => {
    try {
      const before = getAccountPayment(db, req.params.id);
      if (!before) return res.status(404).json({ message: 'Платёж не найден.' });
      deleteAccountPayment(db, before.id);
      const account = getAccount(db, before.account_id);
      const label = before.direction === 'out' ? 'Расход' : 'Приход';
      auditAdminChange(db, req, {
        entityType: 'account_payment',
        entityId: before.id,
        action: 'delete',
        summary: `Удалён ${label.toLowerCase()} ${before.amount} ${before.currency} по счёту «${account?.name || before.account_id}»`,
        details: buildAuditDetails({ before, after: null }),
      });
      return res.json({ ok: true, account });
    } catch (error) {
      return respondWriteError(res, error, 'Не удалось удалить платёж.');
    }
  });
}

module.exports = {
  registerFinancesRoutes,
};
