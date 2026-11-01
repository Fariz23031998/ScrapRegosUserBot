import type { Unchecked } from '../types/unchecked';
import type { Response } from 'express';

export const RECORDING_URL_CACHE_TTL_MS = 10 * 60 * 1000;
export const RECORDING_URL_CACHE_MAX = 1000;

export function seedRecordingUrlCache(cache?: any, ticketId?: any, href?: any) {
  if (!href || ticketId == null) return null;
  let url: any;
  try {
    url = new URL(String(href));
  } catch {
    return null;
  }
  const key = String(ticketId);
  if (!cache.has(key) && cache.size >= RECORDING_URL_CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, {
    href: url.href,
    expiresAt: Date.now() + RECORDING_URL_CACHE_TTL_MS,
  });
  return url;
}

export const CHAT_FILE_CACHE_TTL_MS = 10 * 60 * 1000;

export function collectMessageFileIds(messages?: any) {
  const ids: any[] = [];
  const seen: Set<any> = new Set();
  for (const message of messages || []) {
    const fileIds = Array.isArray(message?.file_ids) ? message.file_ids : [];
    for (const raw of fileIds) {
      const id = Number(raw);
      if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function toPublicChatFile(file?: any) {
  if (!file || file.id == null) return null;
  return {
    id: file.id,
    name: file.name || null,
    extension: file.extension || null,
    mime_type: file.mime_type || null,
    media_type: file.media_type || null,
  };
}

export function isSafeFileUrl(value?: any) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export const CHAT_FILE_MIME_BY_EXTENSION = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  weba: 'audio/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
};

export function isGenericMimeType(value?: any) {
  const mime = String(value || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return !mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream';
}

export function mimeFromChatFileExtension(file?: any) {
  const ext = String(file?.extension || '')
    .trim()
    .replace(/^\./, '')
    .toLowerCase();
  if (ext && (CHAT_FILE_MIME_BY_EXTENSION as Record<string, string>)[ext]) return (CHAT_FILE_MIME_BY_EXTENSION as Record<string, string>)[ext];
  const name = String(file?.name || '')
    .split(/[\\/]/)
    .pop() || '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return (CHAT_FILE_MIME_BY_EXTENSION as Record<string, string>)[name.slice(dot + 1).toLowerCase()] || '';
}

export function resolveChatFileContentType(file?: any, upstreamType?: any) {
  const declared = String(file?.mime_type || '').trim();
  if (declared && !isGenericMimeType(declared)) return declared;
  const upstream = String(upstreamType || '').trim();
  if (upstream && !isGenericMimeType(upstream)) return upstream;
  return mimeFromChatFileExtension(file) || upstream || declared || 'application/octet-stream';
}

/**
 * Fetch remote chat/recording media while following http(s) redirects.
 * `redirect: 'manual'` alone breaks CDN signed-URL hops and leaves <audio>/<video> empty.
 */
export async function fetchUpstreamMedia(url: any, { range = '', signal, maxRedirects = 5 }: Unchecked = {}) {
  let current = String(url || '').trim();
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (!isSafeFileUrl(current)) {
      const error = new Error('Unsafe media URL');
      error.code = 'UNSAFE_MEDIA_URL';
      throw error;
    }
    const headers: Unchecked = {};
    if (/^bytes=\d*-\d*$/i.test(range)) headers.Range = range;
    const response = await fetch(current, {
      headers,
      redirect: 'manual',
      signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }
    const location = response.headers.get('location');
    if (!location) return response;
    current = new URL(location, current).href;
  }
  const error = new Error('Too many media redirects');
  error.code = 'TOO_MANY_REDIRECTS';
  throw error;
}

export function writeSseEvent(res: Response, event?: any) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  if (res.write(frame)) {
    return Promise.resolve();
  }
  return new Promise<any>((resolve?: any, reject?: any) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('SSE connection closed'));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
  });
}
