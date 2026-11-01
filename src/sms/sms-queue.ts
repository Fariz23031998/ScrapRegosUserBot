import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import crypto from 'crypto';
import { logOrderEvent } from '../db/order-logs';
import { formatPhoneForSms, resolveSmsRecipientPhone, formatPaymentMessage, PAYMENT_MESSAGE_CHANNELS } from './sms-message';
import { isGetSmsConfigured, isGetSmsEnabled, sendGetSms } from './getsms-client';
import { isEskizConfigured, isEskizEnabled, sendEskiz } from './eskiz-client';
import { SMS_PENDING_KEY, SMS_NEW_CHANNEL, SMS_JOB_TTL_SEC, isSmsGatewayEnabled, isRedisConfigured, getRedisClient, jobKey } from './redis-client';
import { isTelegramMtprotoConfigured, isTelegramMtprotoEnabled, sendTelegramByPhone } from '../telegram-mtproto/client';

async function enqueueSmsJob(job?: any) {
  const redis = getRedisClient();
  if (!redis) {
    throw new Error('Redis is not configured');
  }

  const payload = JSON.stringify(job);
  await redis
    .multi()
    .set(jobKey(job.id), payload, 'EX', SMS_JOB_TTL_SEC)
    .lpush(SMS_PENDING_KEY, job.id)
    .publish(SMS_NEW_CHANNEL, job.id)
    .exec();

  return job;
}

async function getSmsJob(jobId?: any) {
  const redis = getRedisClient();
  if (!redis) return null;

  const raw = await redis.get(jobKey(jobId));
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function updateSmsJob(jobId?: any, patch?: any) {
  const redis = getRedisClient();
  if (!redis) return null;

  const existing = await getSmsJob(jobId);
  if (!existing) return null;

  const updated = { ...existing, ...patch };
  await redis.set(jobKey(jobId), JSON.stringify(updated), 'EX', SMS_JOB_TTL_SEC);
  return updated;
}

async function removePendingJob(jobId?: any) {
  const redis = getRedisClient();
  if (!redis) return;
  await redis.lrem(SMS_PENDING_KEY, 0, jobId);
}

async function listPendingJobIds() {
  const redis = getRedisClient();
  if (!redis) return [];

  const ids = await redis.lrange(SMS_PENDING_KEY, 0, -1);
  return ids.reverse();
}

async function enqueueOrderPaymentSms(
  db: Db,
  order: any,
  paymentPageUrl: any,
  {
    sendGetSmsFn = sendGetSms,
    sendEskizFn = sendEskiz,
    enqueueSmsJobFn = enqueueSmsJob,
    sendTelegramByPhoneFn = sendTelegramByPhone,
    logOrderEventFn = logOrderEvent,
  }: Unchecked = {}
) {
  if (!paymentPageUrl) {
    return {
      skipped: true,
      reason: 'no_url',
      getsms: { skipped: true, reason: 'no_url' },
      eskiz: { skipped: true, reason: 'no_url' },
      gateway: { skipped: true, reason: 'no_url' },
      mtproto: { skipped: true, reason: 'no_url' },
    };
  }

  const recipientPhone = resolveSmsRecipientPhone(order);
  if (!recipientPhone) {
    return {
      skipped: true,
      reason: 'no_phone',
      getsms: { skipped: true, reason: 'no_phone' },
      eskiz: { skipped: true, reason: 'no_phone' },
      gateway: { skipped: true, reason: 'no_phone' },
      mtproto: { skipped: true, reason: 'no_phone' },
    };
  }

  const formattedPhone = formatPhoneForSms(recipientPhone);
  if (!formattedPhone) {
    return {
      skipped: true,
      reason: 'invalid_phone',
      getsms: { skipped: true, reason: 'invalid_phone' },
      eskiz: { skipped: true, reason: 'invalid_phone' },
      gateway: { skipped: true, reason: 'invalid_phone' },
      mtproto: { skipped: true, reason: 'invalid_phone' },
    };
  }

  const logBase = {
    orderId: order.id,
    actorTelegramId: order.telegram_id ?? null,
    actorPhone: order.bot_user_phone ?? null,
    orderAmount: order.amount,
    clientPhone: recipientPhone,
  };

  function logSmsResult(action?: any) {
    try {
      logOrderEventFn(db, { ...logBase, action });
    } catch (err: any) {
      console.error(`[SMS] Failed to write ${action} order log:`, err.message);
    }
  }

  function buildJob(message?: any) {
    return {
      id: crypto.randomUUID(),
      orderId: order.id,
      phone: formattedPhone,
      message,
      actorTelegramId: logBase.actorTelegramId,
      actorPhone: logBase.actorPhone,
      orderAmount: logBase.orderAmount,
      clientPhone: logBase.clientPhone,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
  }

  let getsms: any;
  if (isGetSmsEnabled()) {
    try {
      const sent = await sendGetSmsFn({
        phone: formattedPhone,
        text: formatPaymentMessage(order, paymentPageUrl, PAYMENT_MESSAGE_CHANNELS.GETSMS),
      });
      logSmsResult('sms_sent');
      getsms = {
        sent: true,
        requestId: sent.requestId,
        messageId: sent.messageId ?? null,
        recipient: recipientPhone,
      };
    } catch (err: any) {
      console.error('[GETSMS] Failed to send payment link SMS:', err.message);
      logSmsResult('sms_failed');
      getsms = { sent: false, error: err.message, recipient: recipientPhone };
    }
  } else {
    getsms = {
      skipped: true,
      reason:
        process.env.ENABLE_GETSMS?.trim() === '1' && !isGetSmsConfigured()
          ? 'not_configured'
          : 'disabled',
    };
  }

  let eskiz: any;
  if (isEskizEnabled()) {
    try {
      const sent = await sendEskizFn({
        phone: formattedPhone,
        text: formatPaymentMessage(order, paymentPageUrl, PAYMENT_MESSAGE_CHANNELS.ESKIZ),
      });
      logSmsResult('sms_sent');
      eskiz = {
        sent: true,
        requestId: sent.requestId,
        recipient: recipientPhone,
      };
    } catch (err: any) {
      console.error('[Eskiz] Failed to send payment link SMS:', err.message);
      logSmsResult('sms_failed');
      eskiz = { sent: false, error: err.message, recipient: recipientPhone };
    }
  } else {
    eskiz = {
      skipped: true,
      reason:
        process.env.ENABLE_ESKIZ?.trim() === '1' && !isEskizConfigured()
          ? 'not_configured'
          : 'disabled',
    };
  }

  let gateway: any;
  if (!isSmsGatewayEnabled()) {
    gateway = { skipped: true, reason: 'disabled' };
  } else if (!isRedisConfigured()) {
    gateway = { skipped: true, reason: 'not_configured' };
  } else {
    try {
      const paymentJob = buildJob(
        formatPaymentMessage(order, paymentPageUrl, PAYMENT_MESSAGE_CHANNELS.SMS_GATEWAY)
      );
      await enqueueSmsJobFn(paymentJob);
      gateway = {
        queued: true,
        jobId: paymentJob.id,
        recipient: recipientPhone,
      };
    } catch (err: any) {
      console.error('[SMS queue] Failed to enqueue payment link SMS:', err.message);
      logSmsResult('sms_failed');
      gateway = { queued: false, error: err.message, recipient: recipientPhone };
    }
  }

  let mtproto: any;
  if (isTelegramMtprotoEnabled()) {
    try {
      const sent = await sendTelegramByPhoneFn({
        phone: formattedPhone,
        text: formatPaymentMessage(order, paymentPageUrl, PAYMENT_MESSAGE_CHANNELS.MTPROTO),
        withGreeting: true,
      });
      logSmsResult('telegram_mtproto_sent');
      mtproto = {
        sent: true,
        recipient: sent.recipient || recipientPhone,
        userId: sent.userId ?? null,
        method: sent.method ?? null,
        greeting: sent.greeting ?? null,
      };
    } catch (err: any) {
      console.error('[MTProto] Failed to send payment link Telegram message:', err.message);
      logSmsResult('telegram_mtproto_failed');
      mtproto = { sent: false, error: err.message, recipient: recipientPhone };
    }
  } else {
    mtproto = {
      skipped: true,
      reason:
        process.env.ENABLE_TELEGRAM_MTPROTO?.trim() === '1' && !isTelegramMtprotoConfigured()
          ? 'not_configured'
          : 'disabled',
    };
  }

  const result: Unchecked = { getsms, eskiz, gateway, mtproto };
  if (getsms.skipped && eskiz.skipped && gateway.skipped && mtproto.skipped) {
    result.skipped = true;
    result.reason = 'no_providers';
  }
  return result;
}

export {
  enqueueOrderPaymentSms,
  enqueueSmsJob,
  getSmsJob,
  updateSmsJob,
  removePendingJob,
  listPendingJobIds,
};
