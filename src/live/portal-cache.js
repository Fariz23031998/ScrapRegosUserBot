const { isRedisConfigured, getRedisClient } = require('../sms/redis-client');

const KEY_PREFIX = 'portal:search:';
const DEFAULT_TTL_BALANCE_SEC = 60;
const DEFAULT_TTL_SEC = 120;

/** @type {Map<string, Promise<unknown>>} */
const inFlight = new Map();

const BALANCE_KINDS = new Set(['partners', 'vcr1_partners']);

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function isPortalCacheEnabled() {
  if (!isRedisConfigured()) return false;
  const flag = process.env.PORTAL_CACHE_ENABLED?.trim();
  // Absent or any value other than "0" keeps cache on when Redis is configured.
  return flag !== '0';
}

function getTtlSec(kind) {
  if (BALANCE_KINDS.has(kind)) {
    return parsePositiveInt(
      process.env.PORTAL_CACHE_TTL_BALANCE_SEC,
      DEFAULT_TTL_BALANCE_SEC
    );
  }
  return parsePositiveInt(process.env.PORTAL_CACHE_TTL_SEC, DEFAULT_TTL_SEC);
}

/**
 * Normalize search text for stable Redis keys.
 * Phone/INN-like inputs collapse to digits; other queries trim + lowercase.
 */
function normalizeQuery(query) {
  const raw = String(query ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!raw) return '';

  const compact = raw.replace(/\s/g, '');
  const digits = compact.replace(/\D/g, '');
  if (digits.length >= 7 && digits.length >= compact.length * 0.7) {
    return digits;
  }
  return raw.toLowerCase();
}

function cacheKey(kind, normalizedQuery) {
  return `${KEY_PREFIX}${kind}:${normalizedQuery}`;
}

async function readCache(key) {
  try {
    const redis = getRedisClient();
    if (!redis) return null;
    const raw = await redis.get(key);
    if (raw == null) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error('[portal-cache] get failed:', err.message || err);
    return null;
  }
}

async function writeCache(key, value, ttlSec) {
  try {
    const redis = getRedisClient();
    if (!redis) return;
    await redis.set(key, JSON.stringify(value), 'EX', ttlSec);
  } catch (err) {
    console.error('[portal-cache] set failed:', err.message || err);
  }
}

/**
 * Cache a portal search. Fail-open: Redis errors skip cache and run fetcher.
 * Concurrent identical (kind, query) calls share one in-flight promise.
 */
async function cachedSearch(kind, query, fetcher) {
  const normalized = normalizeQuery(query);
  if (!normalized || !isPortalCacheEnabled()) {
    return fetcher();
  }

  const key = cacheKey(kind, normalized);
  const ttlSec = getTtlSec(kind);

  const cached = await readCache(key);
  if (cached != null) {
    return cached;
  }

  const existing = inFlight.get(key);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    const result = await fetcher();
    await writeCache(key, result, ttlSec);
    return result;
  })().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, promise);
  return promise;
}

module.exports = {
  KEY_PREFIX,
  DEFAULT_TTL_BALANCE_SEC,
  DEFAULT_TTL_SEC,
  BALANCE_KINDS,
  isPortalCacheEnabled,
  getTtlSec,
  normalizeQuery,
  cacheKey,
  cachedSearch,
};
