const crypto = require('crypto');
const { logOrderEvent } = require('./order-logs');
const {
  formatPhoneForSms,
  resolveSmsRecipientPhone,
  formatSmsPaymentMessage,
} = require('./sms-message');
const {
  SMS_PENDING_KEY,
  SMS_NEW_CHANNEL,
  SMS_JOB_TTL_SEC,
  isRedisConfigured,
  getRedisClient,
  jobKey,
} = require('./redis-client');

async function enqueueSmsJob(job) {
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

async function getSmsJob(jobId) {
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

async function updateSmsJob(jobId, patch) {
  const redis = getRedisClient();
  if (!redis) return null;

  const existing = await getSmsJob(jobId);
  if (!existing) return null;

  const updated = { ...existing, ...patch };
  await redis.set(jobKey(jobId), JSON.stringify(updated), 'EX', SMS_JOB_TTL_SEC);
  return updated;
}

async function removePendingJob(jobId) {
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

async function enqueueOrderPaymentSms(db, order, paymentPageUrl) {
  if (!isRedisConfigured()) {
    return { skipped: true, reason: 'not_configured' };
  }

  if (!paymentPageUrl) {
    return { skipped: true, reason: 'no_url' };
  }

  const recipientPhone = resolveSmsRecipientPhone(order);
  if (!recipientPhone) {
    return { skipped: true, reason: 'no_phone' };
  }

  const formattedPhone = formatPhoneForSms(recipientPhone);
  if (!formattedPhone) {
    return { skipped: true, reason: 'invalid_phone' };
  }

  const message = formatSmsPaymentMessage(order, paymentPageUrl);
  const logBase = {
    orderId: order.id,
    actorTelegramId: order.telegram_id ?? null,
    actorPhone: order.bot_user_phone ?? null,
    orderAmount: order.amount,
    clientPhone: recipientPhone,
  };

  const job = {
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

  try {
    await enqueueSmsJob(job);
    return { queued: true, jobId: job.id, recipient: recipientPhone };
  } catch (err) {
    console.error('[SMS queue] Failed to enqueue payment link SMS:', err.message);
    logOrderEvent(db, { ...logBase, action: 'sms_failed' });
    return { queued: false, error: err.message, recipient: recipientPhone };
  }
}

module.exports = {
  enqueueOrderPaymentSms,
  enqueueSmsJob,
  getSmsJob,
  updateSmsJob,
  removePendingJob,
  listPendingJobIds,
};
