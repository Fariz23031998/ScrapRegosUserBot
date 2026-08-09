const { Readable } = require('stream');
const {
  getTicketRecording,
  upsertTicketRecording,
} = require('../db/ticket-recordings');

const DEFAULT_RECORDING_HOSTS = ['rofeev.7x.uz'];
const DEFAULT_DURATION_TIMEOUT_MS = 8_000;
const DEFAULT_DURATION_MAX_BYTES = 8 * 1024 * 1024;

/** Zero/negative values are treated as parse failures (common with truncated audio). */
function isValidRecordingDuration(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0;
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

async function fetchRecordingDurationSeconds(
  url,
  {
    signal,
    timeoutMs = DEFAULT_DURATION_TIMEOUT_MS,
    maxBytes = DEFAULT_DURATION_MAX_BYTES,
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
    const response = await fetch(parsedUrl.href, {
      redirect: 'manual',
      signal: controller.signal,
    });
    if (![200, 206].includes(response.status) || !response.body) return null;

    const contentType = response.headers.get('content-type') || undefined;
    const contentLengthHeader = Number(response.headers.get('content-length'));
    const chunks = [];
    let total = 0;
    for await (const chunk of Readable.fromWeb(response.body)) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      total += buf.length;
      if (total >= maxBytes) break;
    }

    const buffer = Buffer.concat(chunks, total);
    // Tiny bodies are usually error pages / aborted downloads, not usable audio.
    if (buffer.length < 256) return null;

    const parser = parseBuffer || (await import('music-metadata')).parseBuffer;
    const metadata = await parser(
      buffer,
      {
        mimeType: contentType,
        // Prefer full Content-Length so truncated downloads can still estimate duration.
        size:
          Number.isFinite(contentLengthHeader) && contentLengthHeader > 0
            ? contentLengthHeader
            : buffer.length,
      },
      { duration: true }
    );
    const duration = metadata?.format?.duration;
    return isValidRecordingDuration(duration) ? duration : null;
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

  if (fetchDuration && recordingUrl && durationSeconds == null) {
    const duration = await fetchDurationFn(recordingUrl, { signal, timeoutMs });
    if (isValidRecordingDuration(duration)) {
      row = upsertTicketRecording(db, { ticketId, durationSeconds: duration });
      durationSeconds = isValidRecordingDuration(row?.duration_seconds)
        ? row.duration_seconds
        : duration;
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
  isValidRecordingDuration,
  getAllowedRecordingHosts,
  getTicketRecordingUrl,
  fetchRecordingDurationSeconds,
  resolveTicketRecordingCache,
};
