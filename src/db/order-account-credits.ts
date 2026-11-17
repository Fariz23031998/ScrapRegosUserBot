import type { Db } from '../types/db';
import { createAccountPayment } from './account-payments';
import { listPaymentTypes } from './payment-types';

const ONLINE_PAYMENT_TYPE_CODES = new Set(['payme', 'click']);

function getPaymentTypeByCode(db: Db, code?: any) {
  const normalized = String(code || '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  return listPaymentTypes(db).find((item?: any) => item.code === normalized) || null;
}

function creditOrderToPaymentTypeAccount(
  db: Db,
  {
    orderId,
    amount,
    paymentType,
    currency = 'UZS',
  }: {
    orderId: any;
    amount: any;
    paymentType: any;
    currency?: any;
  }
) {
  if (!paymentType?.account_id) throw new Error('INVALID_ORDER_PAYMENT_TYPE');
  const paymentCurrency = String(currency || paymentType.currency || 'UZS')
    .trim()
    .toUpperCase();
  return createAccountPayment(db, {
    account_id: paymentType.account_id,
    direction: 'in',
    amount,
    currency: paymentCurrency,
    note: `Заказ ${orderId}`,
    order_id: orderId,
  });
}

function creditOrderByPaymentProvider(db: Db, { orderId, amount, provider, currency = 'UZS' }: any) {
  const paymentType = getPaymentTypeByCode(db, provider);
  if (!paymentType) throw new Error('INVALID_ORDER_PAYMENT_TYPE');
  return creditOrderToPaymentTypeAccount(db, {
    orderId,
    amount,
    paymentType,
    currency,
  });
}

function isOnlineOrderPaymentTypeCode(code?: any) {
  return ONLINE_PAYMENT_TYPE_CODES.has(String(code || '').trim().toLowerCase());
}

export {
  ONLINE_PAYMENT_TYPE_CODES,
  getPaymentTypeByCode,
  creditOrderToPaymentTypeAccount,
  creditOrderByPaymentProvider,
  isOnlineOrderPaymentTypeCode,
};
