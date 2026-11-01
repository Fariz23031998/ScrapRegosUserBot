import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { getOpenAiConfig } from './providers/openai';
import { downloadChatFileBytes, fileDisplayName, MAX_AUDIO_FILE_BYTES } from './chat-media';
import { DEFAULT_TRANSCRIBE_MODEL } from './settings';
import { getChatFileExtraction, upsertChatFileExtraction } from '../db/chat-file-extractions';

const transcriptCache: Map<any, any> = new Map();
const MAX_CACHE_ENTRIES = 64;

function optionalPositiveId(value?: any) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function cacheKey(file?: any, bytes?: any) {
  const fileId = optionalPositiveId(file?.id);
  if (fileId) return `id:${fileId}:${bytes || 0}`;
  const name = fileDisplayName(file);
  return `buf:${name}:${bytes || 0}`;
}

function fileIdCacheKey(file?: any) {
  const fileId = optionalPositiveId(file?.id);
  return fileId ? `file:${fileId}` : null;
}

function rememberTranscript(key?: any, text?: any) {
  if (!key || !text) return;
  if (transcriptCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = transcriptCache.keys().next().value;
    if (oldest != null) transcriptCache.delete(oldest);
  }
  transcriptCache.set(key, text);
}

function rememberFileTranscript(file?: any, text?: any, bytes?: any) {
  rememberTranscript(cacheKey(file, bytes), text);
  const idKey = fileIdCacheKey(file);
  if (idKey) rememberTranscript(idKey, text);
}

function readMemoryTranscript(file?: any, bytes?: any) {
  const idKey = fileIdCacheKey(file);
  if (idKey && transcriptCache.has(idKey)) {
    return transcriptCache.get(idKey);
  }
  if (bytes != null && transcriptCache.has(cacheKey(file, bytes))) {
    return transcriptCache.get(cacheKey(file, bytes));
  }
  return null;
}

function clearTranscribeCache() {
  transcriptCache.clear();
}

function audioFilename(file?: any) {
  const name = fileDisplayName(file);
  if (name.includes('.')) return name;
  const ext = String(file?.extension || '')
    .trim()
    .replace(/^\./, '');
  return ext ? `${name}.${ext}` : `${name}.ogg`;
}

function bufferFromFileData(file?: any) {
  const raw = String(file?.data || '').trim();
  if (!raw) return null;
  try {
    const buffer = Buffer.from(raw, 'base64');
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

function persistAudioExtraction(db: Db, file: any, { text, bytes, model, source, ticketId }: Unchecked = {}) {
  if (!db) return;
  try {
    upsertChatFileExtraction(db, {
      fileId: file?.id,
      kind: 'audio',
      text,
      name: fileDisplayName(file),
      mimeType: file?.mime_type || file?.mime || null,
      bytes,
      model,
      source: source || 'transcribe',
      ticketId,
    });
  } catch (error: any) {
    console.warn('[ai] Failed to persist audio transcript:', error.message || error);
  }
}

function readStoredTranscript(db: Db, file?: any) {
  const fileId = optionalPositiveId(file?.id);
  if (!db || !fileId) return null;
  try {
    const stored = getChatFileExtraction(db, fileId);
    if (stored?.kind === 'audio' && stored.text) return stored;
  } catch (error: any) {
    console.warn('[ai] Failed to read stored audio transcript:', error.message || error);
  }
  return null;
}

async function transcribeAudioBuffer(
  buffer: any,
  { filename = 'audio.ogg', model = DEFAULT_TRANSCRIBE_MODEL, transcribeImpl }: Unchecked = {}
) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!data.length) return { skipped: true, reason: 'empty' };
  if (data.length > MAX_AUDIO_FILE_BYTES) return { skipped: true, reason: 'too_large' };

  if (typeof transcribeImpl === 'function') {
    const text = await transcribeImpl({ buffer: data, filename, model });
    const transcript = String(text || '').trim();
    return transcript ? { text: transcript } : { skipped: true, reason: 'empty_transcript' };
  }

  const { apiKey, baseURL } = getOpenAiConfig();
  if (!apiKey) return { skipped: true, reason: 'no_api_key' };

  try {
    const OpenAI = require('openai');
    const { toFile } = OpenAI;
    const client = new OpenAI({ apiKey, baseURL });
    const file = await toFile(data, filename);
    const result = await client.audio.transcriptions.create({
      file,
      model: model || DEFAULT_TRANSCRIBE_MODEL,
    });
    const transcript = String(result?.text || '').trim();
    return transcript ? { text: transcript } : { skipped: true, reason: 'empty_transcript' };
  } catch (error: any) {
    console.warn('[ai] audio transcription failed:', error.message || error);
    return { skipped: true, reason: 'transcribe_failed' };
  }
}

async function transcribeChatAudio(
  file: any,
  {
    db = null,
    ticketId = null,
    source = 'transcribe',
    model = DEFAULT_TRANSCRIBE_MODEL,
    downloadBytes = downloadChatFileBytes,
    transcribeImpl,
  }: Unchecked = {}
) {
  const cached = readMemoryTranscript(file);
  if (cached) return { text: cached, cached: true };

  const stored = readStoredTranscript(db, file);
  if (stored?.text) {
    rememberFileTranscript(file, stored.text, stored.bytes);
    return { text: stored.text, cached: true };
  }

  let buffer = bufferFromFileData(file);
  let bytes = buffer?.length || 0;
  if (!buffer) {
    const downloaded = await downloadBytes(file, { maxBytes: MAX_AUDIO_FILE_BYTES });
    if (!downloaded?.buffer) {
      return { skipped: true, reason: downloaded?.reason || 'download_failed' };
    }
    buffer = downloaded.buffer;
    bytes = downloaded.bytes || buffer!.length;
  }

  const afterDownload = readMemoryTranscript(file, bytes);
  if (afterDownload) return { text: afterDownload, cached: true };

  const result = await transcribeAudioBuffer(buffer, {
    filename: audioFilename(file),
    model,
    transcribeImpl,
  });
  if (result?.text) {
    rememberFileTranscript(file, result.text, bytes);
    persistAudioExtraction(db, file, {
      text: result.text,
      bytes,
      model,
      source,
      ticketId,
    });
  }
  return result;
}

function formatAudioTranscript(text?: any) {
  const value = String(text || '').trim();
  return value ? `Расшифровка: ${value}` : '';
}

export {
  transcribeAudioBuffer,
  transcribeChatAudio,
  formatAudioTranscript,
  clearTranscribeCache,
};
