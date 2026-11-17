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

function normalizeTranscriptSegments(result?: any, { durationMs = null }: Unchecked = {}) {
  const segments: any[] = [];
  const rawSegments = Array.isArray(result?.segments) ? result.segments : [];
  for (const item of rawSegments) {
    const text = String(item?.text || '').trim();
    if (!text) continue;
    const startSec = Number(item?.start);
    const endSec = Number(item?.end);
    const startMs = Number.isFinite(startSec) ? Math.max(0, Math.round(startSec * 1000)) : 0;
    let endMs = Number.isFinite(endSec) ? Math.max(startMs, Math.round(endSec * 1000)) : startMs;
    segments.push({ start_ms: startMs, end_ms: endMs, text });
  }
  if (segments.length) return segments;

  const text = String(result?.text || '').trim();
  if (!text) return [];
  const endMs =
    durationMs != null && Number.isFinite(Number(durationMs))
      ? Math.max(0, Math.round(Number(durationMs)))
      : 0;
  return [{ start_ms: 0, end_ms: endMs, text }];
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

async function transcribeAudioBufferTimed(
  buffer: any,
  {
    filename = 'audio.wav',
    model = DEFAULT_TRANSCRIBE_MODEL,
    durationMs = null,
    transcribeImpl,
  }: Unchecked = {}
) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!data.length) return { skipped: true, reason: 'empty' };
  if (data.length > MAX_AUDIO_FILE_BYTES) return { skipped: true, reason: 'too_large' };

  if (typeof transcribeImpl === 'function') {
    const result = await transcribeImpl({ buffer: data, filename, model, timed: true });
    if (result?.skipped) return result;
    if (Array.isArray(result?.segments)) {
      const segments = normalizeTranscriptSegments(
        { segments: result.segments, text: result.text },
        { durationMs }
      );
      return segments.length
        ? { text: segments.map((s) => s.text).join(' ').trim(), segments }
        : { skipped: true, reason: 'empty_transcript' };
    }
    const transcript = String(result?.text ?? result ?? '').trim();
    if (!transcript) return { skipped: true, reason: 'empty_transcript' };
    const segments = normalizeTranscriptSegments({ text: transcript }, { durationMs });
    return { text: transcript, segments };
  }

  const { apiKey, baseURL } = getOpenAiConfig();
  if (!apiKey) return { skipped: true, reason: 'no_api_key' };

  try {
    const OpenAI = require('openai');
    const { toFile } = OpenAI;
    const client = new OpenAI({ apiKey, baseURL });
    const file = await toFile(data, filename);
    const selectedModel = model || DEFAULT_TRANSCRIBE_MODEL;
    let result: any;
    try {
      result = await client.audio.transcriptions.create({
        file,
        model: selectedModel,
        response_format: 'verbose_json',
      });
    } catch (verboseError: any) {
      // Some models only accept json/text — fall back and store one segment.
      console.warn(
        '[ai] verbose_json transcription failed, falling back to text:',
        verboseError.message || verboseError
      );
      const plainFile = await toFile(data, filename);
      result = await client.audio.transcriptions.create({
        file: plainFile,
        model: selectedModel,
      });
    }
    const segments = normalizeTranscriptSegments(result, { durationMs });
    if (!segments.length) return { skipped: true, reason: 'empty_transcript' };
    return {
      text: String(result?.text || segments.map((s) => s.text).join(' ')).trim(),
      segments,
    };
  } catch (error: any) {
    console.warn('[ai] timed audio transcription failed:', error.message || error);
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
  transcribeAudioBufferTimed,
  normalizeTranscriptSegments,
  transcribeChatAudio,
  formatAudioTranscript,
  clearTranscribeCache,
};
