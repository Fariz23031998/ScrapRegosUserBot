import type { Unchecked } from '../types/unchecked';
import type TelegramBot from 'node-telegram-bot-api';
import { isChatImage, isChatAudio, isChatVideo, MAX_FILE_BYTES, MAX_AUDIO_FILE_BYTES, DOWNLOAD_TIMEOUT_MS } from '../ai/chat-media';

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'weba',
};

const IMAGE_FALLBACK_TEXT = 'Фото из Telegram';
const AUDIO_FALLBACK_TEXT = 'Голосовое сообщение из Telegram';

function extensionFromName(name?: any) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

function extensionFromMime(mime?: any) {
  const key = String(mime || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return MIME_EXTENSIONS[key] || '';
}

function resolveExtension({ name, mimeType, fallback }: Unchecked) {
  return extensionFromName(name) || extensionFromMime(mimeType) || fallback || '';
}

function documentDescriptor(doc?: any) {
  const name = String(doc?.file_name || '').trim();
  const mimeType = String(doc?.mime_type || '').trim();
  const extension = resolveExtension({ name, mimeType });
  return {
    name: name || (extension ? `file.${extension}` : 'file'),
    mime_type: mimeType,
    extension,
  };
}

function pickLargestPhoto(photos: any, maxBytes: any = MAX_FILE_BYTES) {
  const list = Array.isArray(photos) ? photos.filter((item?: any) => item?.file_id) : [];
  if (!list.length) return null;
  const sorted = [...list].sort((a?: any, b?: any) => {
    const areaA = Number(a.width || 0) * Number(a.height || 0);
    const areaB = Number(b.width || 0) * Number(b.height || 0);
    if (areaA !== areaB) return areaB - areaA;
    return Number(b.file_size || 0) - Number(a.file_size || 0);
  });
  const underLimit = sorted.find((item?: any) => !item.file_size || item.file_size <= maxBytes);
  return underLimit || sorted[0];
}

function maxBytesForKind(kind?: any) {
  return kind === 'audio' ? MAX_AUDIO_FILE_BYTES : MAX_FILE_BYTES;
}

function classifyTelegramMedia(msg?: any) {
  if (msg?.video || msg?.video_note || msg?.animation) {
    return { status: 'video', attachments: [], text: '' };
  }

  if (msg?.sticker) {
    return { status: 'unsupported', attachments: [], text: '' };
  }

  const attachments: any[] = [];

  if (Array.isArray(msg?.photo) && msg.photo.length) {
    const photo = pickLargestPhoto(msg.photo);
    if (photo) {
      attachments.push({
        kind: 'image',
        fileId: photo.file_id,
        name: 'photo.jpg',
        extension: 'jpg',
        mime_type: 'image/jpeg',
        width: photo.width,
        height: photo.height,
        fileSize: photo.file_size,
        fallbackText: IMAGE_FALLBACK_TEXT,
      });
    }
  }

  if (msg?.voice?.file_id) {
    attachments.push({
      kind: 'audio',
      fileId: msg.voice.file_id,
      name: 'voice.ogg',
      extension: 'ogg',
      mime_type: msg.voice.mime_type || 'audio/ogg',
      durationMs: msg.voice.duration != null ? Number(msg.voice.duration) * 1000 : undefined,
      fileSize: msg.voice.file_size,
      fallbackText: AUDIO_FALLBACK_TEXT,
    });
  }

  if (msg?.audio?.file_id) {
    const name = String(msg.audio.file_name || '').trim() || 'audio.mp3';
    const extension = resolveExtension({
      name,
      mimeType: msg.audio.mime_type,
      fallback: 'mp3',
    });
    attachments.push({
      kind: 'audio',
      fileId: msg.audio.file_id,
      name: extensionFromName(name) ? name : `audio.${extension}`,
      extension,
      mime_type: msg.audio.mime_type || 'audio/mpeg',
      durationMs: msg.audio.duration != null ? Number(msg.audio.duration) * 1000 : undefined,
      fileSize: msg.audio.file_size,
      fallbackText: AUDIO_FALLBACK_TEXT,
    });
  }

  if (msg?.document) {
    const file = documentDescriptor(msg.document);
    if (isChatVideo(file) || String(file.mime_type || '').startsWith('video/')) {
      return { status: 'video', attachments: [], text: '' };
    }
    if (isChatImage(file)) {
      attachments.push({
        kind: 'image',
        fileId: msg.document.file_id,
        name: file.name,
        extension: file.extension || 'jpg',
        mime_type: file.mime_type,
        fileSize: msg.document.file_size,
        fallbackText: IMAGE_FALLBACK_TEXT,
      });
    } else if (isChatAudio(file)) {
      attachments.push({
        kind: 'audio',
        fileId: msg.document.file_id,
        name: file.name,
        extension: file.extension || 'ogg',
        mime_type: file.mime_type,
        fileSize: msg.document.file_size,
        fallbackText: AUDIO_FALLBACK_TEXT,
      });
    } else {
      return { status: 'unsupported', attachments: [], text: '' };
    }
  }

  const text = String(msg?.text || msg?.caption || '').trim();
  if (!attachments.length && !text) {
    return { status: 'empty', attachments: [], text: '' };
  }
  if (!attachments.length) {
    return { status: 'text', attachments: [], text };
  }
  return {
    status: 'media',
    attachments,
    text,
    fallbackText: attachments[0].fallbackText,
  };
}

function tooLargeError() {
  const error = new Error('too-large');
  error.code = 'too-large';
  return error;
}

async function readStreamToBuffer(stream: any, { maxBytes, timeoutMs = DOWNLOAD_TIMEOUT_MS }: Unchecked = {}) {
  return new Promise<any>((resolve?: any, reject?: any) => {
    const chunks: any[] = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      const error = new Error('timeout');
      error.code = 'timeout';
      finish(error);
      try {
        stream.destroy();
      } catch {
        // ignore
      }
    }, timeoutMs);

    function finish(error: Error | null, value?: any) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }

    stream.on('data', (chunk?: any) => {
      size += chunk.length;
      if (size > maxBytes) {
        try {
          stream.destroy();
        } catch {
          // ignore
        }
        finish(tooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => finish(null, Buffer.concat(chunks)));
    stream.on('error', (error: Error) => finish(error));
  });
}

async function downloadTelegramFile(bot: TelegramBot, attachment: any, { maxBytes, timeoutMs }: Unchecked = {}) {
  const limit = maxBytes || maxBytesForKind(attachment?.kind);
  if (attachment?.fileSize && attachment.fileSize > limit) {
    throw tooLargeError();
  }
  if (!bot?.getFileStream) {
    throw new Error('Telegram file download is not available.');
  }
  const stream = bot.getFileStream(attachment.fileId);
  return readStreamToBuffer(stream, { maxBytes: limit, timeoutMs });
}

async function uploadTelegramAttachments({ bot, chatId, attachments, deps = {} }: Unchecked = {}) {
  const addFile = deps.addChatFile || (require('../integrations/regos-crm') as typeof import('../integrations/regos-crm')).addChatFile;
  const download = deps.downloadTelegramFile || ((item?: any) => downloadTelegramFile(bot, item));
  const fileIds: any[] = [];
  for (const attachment of attachments || []) {
    const buffer = await download(attachment);
    if (!buffer?.length) {
      throw tooLargeError();
    }
    const uploaded = await addFile({
      chatId,
      name: attachment.name,
      extension: attachment.extension,
      data: Buffer.isBuffer(buffer) ? buffer.toString('base64') : String(buffer),
      width: attachment.width,
      height: attachment.height,
      durationMs: attachment.durationMs,
    });
    if (uploaded?.file_id) {
      fileIds.push(uploaded.file_id);
    }
  }
  return fileIds;
}

export {
  IMAGE_FALLBACK_TEXT,
  AUDIO_FALLBACK_TEXT,
  classifyTelegramMedia,
  pickLargestPhoto,
  downloadTelegramFile,
  uploadTelegramAttachments,
  readStreamToBuffer,
};
