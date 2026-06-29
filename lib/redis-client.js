const Redis = require('ioredis');

const SMS_PENDING_KEY = 'sms:pending';
const SMS_JOB_PREFIX = 'sms:job:';
const SMS_NEW_CHANNEL = 'sms:new';
const SMS_JOB_TTL_SEC = 7 * 24 * 60 * 60;

let sharedClient = null;

function isRedisConfigured() {
  return Boolean(process.env.REDIS_URL?.trim());
}

function getRedisUrl() {
  return process.env.REDIS_URL?.trim() || null;
}

function createRedisClient({ forSubscriber = false } = {}) {
  const url = getRedisUrl();
  if (!url) {
    throw new Error('REDIS_URL is not configured');
  }

  const client = new Redis(url, {
    maxRetriesPerRequest: forSubscriber ? null : 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  client.on('error', (err) => {
    console.error('[Redis]', err.message);
  });

  return client;
}

function getRedisClient() {
  if (!isRedisConfigured()) {
    return null;
  }
  if (!sharedClient) {
    sharedClient = createRedisClient();
  }
  return sharedClient;
}

function jobKey(jobId) {
  return `${SMS_JOB_PREFIX}${jobId}`;
}

module.exports = {
  SMS_PENDING_KEY,
  SMS_JOB_PREFIX,
  SMS_NEW_CHANNEL,
  SMS_JOB_TTL_SEC,
  isRedisConfigured,
  getRedisUrl,
  createRedisClient,
  getRedisClient,
  jobKey,
};
