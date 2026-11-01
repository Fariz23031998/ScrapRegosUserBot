import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { getProvider } from './providers/registry';
import { downloadChatFile, fileDisplayName, isVisionImage, toImageUrlPart } from './chat-media';
import { DEFAULT_MODEL, loadAiSettings } from './settings';
import { getChatFileExtraction, upsertChatFileExtraction } from '../db/chat-file-extractions';

const CAPTION_PROMPT =
  'Опиши скриншот поддержки в 1–2 предложениях. Только факты с изображения, без домыслов.';

const captionCache: Map<any, any> = new Map();
const MAX_CACHE_ENTRIES = 64;

function optionalPositiveId(value?: any) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function fileIdCacheKey(file?: any) {
  const fileId = optionalPositiveId(file?.id);
  return fileId ? `file:${fileId}` : null;
}

function rememberCaption(key?: any, text?: any) {
  if (!key || !text) return;
  if (captionCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = captionCache.keys().next().value;
    if (oldest != null) captionCache.delete(oldest);
  }
  captionCache.set(key, text);
}

function clearCaptionCache() {
  captionCache.clear();
}

function resolveCaptionProviderName(db: Db, providerName?: any) {
  const explicit = String(providerName || '').trim();
  if (explicit) return explicit;
  if (!db) return 'openai';
  try {
    return loadAiSettings(db).provider || 'openai';
  } catch {
    return 'openai';
  }
}

function persistImageCaption(db: Db, file: any, { text, bytes, model, source, ticketId }: Unchecked = {}) {
  if (!db) return;
  try {
    upsertChatFileExtraction(db, {
      fileId: file?.id,
      kind: 'image',
      text,
      name: fileDisplayName(file),
      mimeType: file?.mime_type || file?.mime || null,
      bytes,
      model,
      source: source || 'caption',
      ticketId,
    });
  } catch (error: any) {
    console.warn('[ai] Failed to persist image caption:', error.message || error);
  }
}

function readStoredCaption(db: Db, file?: any) {
  const fileId = optionalPositiveId(file?.id);
  if (!db || !fileId) return null;
  try {
    const stored = getChatFileExtraction(db, fileId);
    if (stored?.kind === 'image' && stored.text) return stored;
  } catch (error: any) {
    console.warn('[ai] Failed to read stored image caption:', error.message || error);
  }
  return null;
}

async function captionImageBuffer(
  downloaded: any,
  { model = DEFAULT_MODEL, captionImpl, chatImpl, providerName }: Unchecked = {}
) {
  const part = toImageUrlPart(downloaded);
  if (!part) return { skipped: true, reason: 'empty' };

  if (typeof captionImpl === 'function') {
    const text = await captionImpl({ downloaded, model, part });
    const caption = String(text || '').trim();
    return caption ? { text: caption } : { skipped: true, reason: 'empty_caption' };
  }

  const chat =
    typeof chatImpl === 'function'
      ? chatImpl
      : getProvider(providerName || 'openai').chat;
  try {
    const result = await chat({
      model: model || DEFAULT_MODEL,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: CAPTION_PROMPT }, part],
        },
      ],
      tools: [],
    });
    const caption = String(result?.content || '').trim();
    return caption ? { text: caption } : { skipped: true, reason: 'empty_caption' };
  } catch (error: any) {
    console.warn('[ai] image caption failed:', error.message || error);
    return { skipped: true, reason: 'caption_failed' };
  }
}

async function captionChatImage(
  file: any,
  {
    db = null,
    ticketId = null,
    source = 'caption',
    model = DEFAULT_MODEL,
    providerName = null,
    download = downloadChatFile,
    captionImpl,
    chatImpl,
  }: Unchecked = {}
) {
  if (!isVisionImage(file)) return { skipped: true, reason: 'not_an_image' };

  const idKey = fileIdCacheKey(file);
  if (idKey && captionCache.has(idKey)) {
    return { text: captionCache.get(idKey), cached: true };
  }

  const stored = readStoredCaption(db, file);
  if (stored?.text) {
    if (idKey) rememberCaption(idKey, stored.text);
    return { text: stored.text, cached: true };
  }

  const downloaded = await download(file);
  if (!downloaded?.base64) {
    return { skipped: true, reason: downloaded?.reason || 'download_failed' };
  }

  const resolvedProvider = resolveCaptionProviderName(db, providerName);
  const result = await captionImageBuffer(downloaded, {
    model,
    captionImpl,
    chatImpl,
    providerName: resolvedProvider,
  });
  if (result?.text) {
    if (idKey) rememberCaption(idKey, result.text);
    persistImageCaption(db, file, {
      text: result.text,
      bytes: downloaded.bytes,
      model,
      source,
      ticketId,
    });
  }
  return result;
}

function formatImageCaption(text?: any) {
  const value = String(text || '').trim();
  return value ? `Описание: ${value}` : '';
}

export {
  CAPTION_PROMPT,
  captionChatImage,
  formatImageCaption,
  clearCaptionCache,
};
