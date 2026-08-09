const { Readable } = require('stream');
const {
  getTicketRecording,
  upsertTicketRecording,
} = require('../db/ticket-recordings');

const DEFAULT_RECORDING_HOSTS = ['rofeev.7x.uz'];
const DEFAULT_DURATION_TIMEOUT_MS = 8_000;
const DEFAULT_DURATION_MAX_BYTES = 8 * 1024 * 1024;
/** Enough for RIFF headers; production recordings are multi‑MB WAVs. */
const DURATION_HEADER_BYTES = 64 * 1024;
/** Avoid re-downloading audio on every tickets refresh after a failed parse. */
const DURATION_RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** Zero/negative values are treated as parse failures (common with truncated audio). */
function isValidRecordingDuration(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0;
}

function shouldAttemptDurationFetch(row, { force = false } = {}) {
  if (force) return true;
  if (isValidRecordingDuration(row?.duration_seconds)) return false;
  if (!row?.duration_checked_at) return true;
  const checkedAt = Date.parse(row.duration_checked_at);
  if (!Number.isFinite(checkedAt)) return true;
  return Date.now() - checkedAt >= DURATION_RETRY_COOLDOWN_MS;
}

function getAllowedRecordingHosts() {
  const configured = String(process.env.REGOS_RECORDING_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return new Set(configured.length ? configured : DEFAULT_RECORDING_HOSTS);
}

function getTicketRecordingUrl(ticket) {
  const fields = Array.isArray(ticket?.fields) ? ticket.fields : [];
  const recordingField = fields.find((field) => {
    const key = String(field?.key || '').trim().toLowerCase();
    const name = String(field?.name || '').trim().toLowerCase();
    return key === 'field_recording_link' || name === 'ссылка на запись';
  });
  const value = String(recordingField?.value || '').trim();
  if (!value) return null;

  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (!getAllowedRecordingHosts().has(url.host.toLowerCase())) return null;
    return url;
  } catch {
    return null;
  }
}

function normalizeRecordingUrl(url) {
  if (!url) return null;
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (!getAllowedRecordingHosts().has(parsed.host.toLowerCase())) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Read duration from a WAV RIFF header (fmt byteRate + data chunk size).
 * Works from the first few KB; does not need the audio payload.
 */
function parseWavDurationSeconds(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return null;

  let offset = 12;
  let byteRate = null;
  let dataSize = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;

    if (chunkId === 'fmt ' && dataStart + 16 <= buffer.length) {
      // PCM fmt: audioFormat(2), channels(2), sampleRate(4), byteRate(4), ...
      byteRate = buffer.readUInt32LE(dataStart + 8);
    } else if (chunkId === 'data') {
      dataSize = chunkSize;
      break;
    }

    offset = dataStart + chunkSize + (chunkSize % 2);
  }

  if (!Number.isFinite(byteRate) || byteRate <= 0) return null;
  if (!Number.isFinite(dataSize) || dataSize <= 0) return null;
  const duration = dataSize / byteRate;
  return isValidRecordingDuration(duration) ? duration : null;
}

async function readResponsePrefix(response, maxBytes) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buf);
    total += buf.length;
    if (total >= maxBytes) break;
  }
  return Buffer.concat(chunks, Math.min(total, maxBytes));
}

async function durationFromBuffer(buffer, { contentType, fileSize, parseBuffer } = {}) {
  const wavDuration = parseWavDurationSeconds(buffer);
  if (isValidRecordingDuration(wavDuration)) return wavDuration;

  if (buffer.length < 256) return null;
  const parser = parseBuffer || (await import('music-metadata')).parseBuffer;
  const metadata = await parser(
    buffer,
    {
      mimeType: contentType,
      size: Number.isFinite(fileSize) && fileSize > 0 ? fileSize : buffer.length,
    },
    { duration: true }
  );
  const duration = metadata?.format?.duration;
  return isValidRecordingDuration(duration) ? duration : null;
}

async function fetchRecordingDurationSeconds(
  url,
  {
    signal,
    timeoutMs = DEFAULT_DURATION_TIMEOUT_MS,
    maxBytes = DEFAULT_DURATION_MAX_BYTES,
    headerBytes = DURATION_HEADER_BYTES,
    parseBuffer,
  } = {}
) {
  const parsedUrl = normalizeRecordingUrl(url);
  if (!parsedUrl) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || DEFAULT_DURATION_TIMEOUT_MS));
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      return null;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const prefixLimit = Math.min(
      Math.max(4 * 1024, Number(headerBytes) || DURATION_HEADER_BYTES),
      Math.max(4 * 1024, Number(maxBytes) || DEFAULT_DURATION_MAX_BYTES)
    );

    // Prefer a tiny Range GET — production WAV files are multi‑MB and full downloads time out.
    const rangeResponse = await fetch(parsedUrl.href, {
      headers: { Range: `bytes=0-${prefixLimit - 1}` },
      redirect: 'manual',
      signal: controller.signal,
    });

    if ([200, 206].includes(rangeResponse.status) && rangeResponse.body) {
      const contentType = rangeResponse.headers.get('content-type') || undefined;
      const contentRange = String(rangeResponse.headers.get('content-range') || '');
      const rangeTotal = Number((contentRange.match(/\/(\d+)\s*$/) || [])[1]);
      const contentLength = Number(rangeResponse.headers.get('content-length'));
      const buffer = await readResponsePrefix(rangeResponse, prefixLimit);
      const duration = await durationFromBuffer(buffer, {
        contentType,
        fileSize: Number.isFinite(rangeTotal) && rangeTotal > 0 ? rangeTotal : contentLength,
        parseBuffer,
      });
      if (isValidRecordingDuration(duration)) return duration;
      // 206 with unparsable header: do not pull the whole file on the list path.
      if (rangeResponse.status === 206) return null;
    }

    // Fallback when the host ignores Range and returns a normal 200 body.
    const response = await fetch(parsedUrl.href, {
      redirect: 'manual',
      signal: controller.signal,
    });
    if (![200, 206].includes(response.status) || !response.body) return null;

    const contentType = response.headers.get('content-type') || undefined;
    const contentLengthHeader = Number(response.headers.get('content-length'));
    const buffer = await readResponsePrefix(response, Math.max(prefixLimit, Number(maxBytes) || DEFAULT_DURATION_MAX_BYTES));
    return durationFromBuffer(buffer, {
      contentType,
      fileSize: contentLengthHeader,
      parseBuffer,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Sync REGOS ticket fields into SQLite and optionally fetch audio duration.
 * Returns the cached `{ recording_url, duration_seconds }` shape.
 */
async function resolveTicketRecordingCache(
  db,
  ticket,
  {
    fetchDuration = true,
    forceDurationFetch = false,
    fetchDurationFn = fetchRecordingDurationSeconds,
    signal,
    timeoutMs,
  } = {}
) {
  const ticketId = Number(ticket?.id);
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    return { recording_url: null, duration_seconds: null };
  }

  const fieldUrl = getTicketRecordingUrl(ticket);
  const fieldHref = fieldUrl?.href || null;
  let row = getTicketRecording(db, ticketId);

  if (fieldHref && (!row?.recording_url || row.recording_url !== fieldHref)) {
    row = upsertTicketRecording(db, { ticketId, recordingUrl: fieldHref });
  }

  const recordingUrl = row?.recording_url || fieldHref || null;
  let durationSeconds = isValidRecordingDuration(row?.duration_seconds)
    ? row.duration_seconds
    : null;

  if (
    fetchDuration &&
    recordingUrl &&
    durationSeconds == null &&
    shouldAttemptDurationFetch(row, { force: forceDurationFetch })
  ) {
    const duration = await fetchDurationFn(recordingUrl, { signal, timeoutMs });
    if (isValidRecordingDuration(duration)) {
      row = upsertTicketRecording(db, {
        ticketId,
        durationSeconds: duration,
        markDurationChecked: true,
      });
      durationSeconds = isValidRecordingDuration(row?.duration_seconds)
        ? row.duration_seconds
        : duration;
    } else {
      // Remember the failed attempt so list refresh does not re-download every time.
      row = upsertTicketRecording(db, { ticketId, markDurationChecked: true });
    }
  }

  return {
    recording_url: recordingUrl,
    duration_seconds: durationSeconds,
  };
}

module.exports = {
  DEFAULT_RECORDING_HOSTS,
  DEFAULT_DURATION_TIMEOUT_MS,
  DEFAULT_DURATION_MAX_BYTES,
  DURATION_HEADER_BYTES,
  DURATION_RETRY_COOLDOWN_MS,
  isValidRecordingDuration,
  shouldAttemptDurationFetch,
  parseWavDurationSeconds,
  getAllowedRecordingHosts,
  getTicketRecordingUrl,
  fetchRecordingDurationSeconds,
  resolveTicketRecordingCache,
};
