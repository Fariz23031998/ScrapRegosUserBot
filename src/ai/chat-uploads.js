const {
  classifyChatFile,
  formatFileStub,
  isChatAudio,
  isVisionImage,
  toImageUrlPart,
  MAX_INLINE_AUDIO,
  MAX_INLINE_IMAGES,
} = require('./chat-media');
const { formatAudioTranscript, transcribeChatAudio } = require('./transcribe');

const MAX_CHAT_FILES = 5;
const MAX_CHAT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CHAT_FILE_NAME = 200;
const MAX_CHAT_FILE_EXTENSION = 10;
const CHAT_MESSAGE_JSON_LIMIT = '12mb';

const MIME_BY_EXTENSION = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/opus',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
};

function stripChatFileBase64(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const comma = raw.indexOf(',');
  if (/^data:/i.test(raw) && comma >= 0) {
    return raw.slice(comma + 1).replace(/\s+/g, '');
  }
  return raw.replace(/\s+/g, '');
}

function mimeFromExtension(extension) {
  return MIME_BY_EXTENSION[String(extension || '').toLowerCase()] || '';
}

function parseChatUploadFiles(rawFiles) {
  if (rawFiles == null || rawFiles === '') return [];
  if (!Array.isArray(rawFiles)) {
    const error = new Error('Некорректный список файлов.');
    error.status = 400;
    throw error;
  }
  if (rawFiles.length > MAX_CHAT_FILES) {
    const error = new Error(`Можно прикрепить не больше ${MAX_CHAT_FILES} файлов.`);
    error.status = 400;
    throw error;
  }

  return rawFiles.map((item, index) => {
    const name = String(item?.name || '').trim() || `file-${index + 1}`;
    if (name.length > MAX_CHAT_FILE_NAME) {
      const error = new Error('Имя файла слишком длинное.');
      error.status = 400;
      throw error;
    }

    let extension = String(item?.extension || '')
      .trim()
      .replace(/^\./, '');
    if (!extension) {
      const dot = name.lastIndexOf('.');
      if (dot > 0 && dot < name.length - 1) {
        extension = name.slice(dot + 1);
      }
    }
    extension = extension.toLowerCase();
    if (!extension || extension.length > MAX_CHAT_FILE_EXTENSION || /[^a-z0-9]/i.test(extension)) {
      const error = new Error('Укажите корректное расширение файла.');
      error.status = 400;
      throw error;
    }

    const data = stripChatFileBase64(item?.data);
    let buffer;
    try {
      buffer = data ? Buffer.from(data, 'base64') : null;
    } catch {
      buffer = null;
    }
    if (!buffer || !buffer.length) {
      const error = new Error('Файл пустой или повреждён.');
      error.status = 400;
      throw error;
    }
    if (buffer.length > MAX_CHAT_FILE_BYTES) {
      const error = new Error('Файл слишком большой (максимум 10 МБ).');
      error.status = 400;
      throw error;
    }

    const mimeType = String(item?.mime_type || item?.mime || '').split(';')[0].trim() || mimeFromExtension(extension);
    const parsed = {
      name,
      extension,
      data: buffer.toString('base64'),
      mime_type: mimeType || null,
      size: buffer.length,
      kind: classifyChatFile({ name, extension, mime_type: mimeType }),
    };
    const width = Number(item?.width);
    const height = Number(item?.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      parsed.width = Math.round(width);
      parsed.height = Math.round(height);
    }
    return parsed;
  });
}

function parseStoredAttachments(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((item) => item && item.name);
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.filter((item) => item && item.name) : [];
  } catch {
    return [];
  }
}

function toStoredAttachments(files) {
  return (files || []).map((file) => {
    const kind = file.kind || classifyChatFile(file);
    const stored = {
      name: file.name,
      extension: file.extension || '',
      mime_type: file.mime_type || mimeFromExtension(file.extension) || null,
      kind,
      size: file.size || null,
    };
    if ((kind === 'image' || kind === 'audio' || kind === 'video') && file.data) {
      stored.data = file.data;
    }
    return stored;
  });
}

function stringifyAttachments(files) {
  const stored = toStoredAttachments(files);
  return stored.length ? JSON.stringify(stored) : null;
}

function toPublicAttachments(files) {
  return (files || []).map((file) => {
    const kind = file.kind || classifyChatFile(file);
    const mime = file.mime_type || mimeFromExtension(file.extension) || 'application/octet-stream';
    const publicFile = {
      name: file.name,
      extension: file.extension || '',
      mime_type: mime,
      kind,
      size: file.size || null,
      data_url: null,
    };
    if (file.data && (kind === 'image' || kind === 'audio' || kind === 'video')) {
      publicFile.data_url = `data:${mime};base64,${file.data}`;
    }
    return publicFile;
  });
}

function displayTextWithFiles(text, files) {
  const stubs = (files || []).map(formatFileStub);
  return [String(text || '').trim(), ...stubs].filter(Boolean).join('\n');
}

async function buildUploadedMessageContent(text, files = [], { transcribe, transcribeModel } = {}) {
  let display = displayTextWithFiles(text, files) || 'Вложение.';
  const audioFiles = (files || []).filter(isChatAudio).slice(0, MAX_INLINE_AUDIO);
  if (audioFiles.length) {
    const transcribeFile = transcribe || transcribeChatAudio;
    const extras = [];
    for (const file of audioFiles) {
      try {
        const result = await transcribeFile(file, { model: transcribeModel });
        const line = formatAudioTranscript(result?.text);
        if (line) extras.push(line);
      } catch (error) {
        console.warn('[ai] Failed to transcribe uploaded audio:', error.message || error);
      }
    }
    if (extras.length) display = [display, ...extras].filter(Boolean).join('\n');
  }
  const parts = [];
  for (const file of (files || []).filter(isVisionImage).slice(0, MAX_INLINE_IMAGES)) {
    const base64 = String(file.data || '').trim();
    if (!base64) continue;
    const mime = file.mime_type || mimeFromExtension(file.extension) || 'image/jpeg';
    const part = toImageUrlPart({ mime, base64 });
    if (part) parts.push(part);
  }
  if (!parts.length) return display;
  return [{ type: 'text', text: display }, ...parts];
}

function mapSessionMessage(row) {
  if (!row) return null;
  const files = toPublicAttachments(parseStoredAttachments(row.attachments));
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    content: row.content,
    created_at: row.created_at,
    files,
  };
}

function toModelHistory(messages, { lastUserContent } = {}) {
  return (messages || []).map((item, index) => {
    const isLastUser = index === messages.length - 1 && item.role === 'user' && lastUserContent != null;
    if (isLastUser) {
      return { role: 'user', content: lastUserContent };
    }
    const files = Array.isArray(item.files) ? item.files : [];
    const content =
      item.role === 'assistant'
        ? item.content
        : displayTextWithFiles(item.content, files) || item.content;
    return {
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content,
    };
  });
}

module.exports = {
  MAX_CHAT_FILES,
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_FILE_NAME,
  MAX_CHAT_FILE_EXTENSION,
  CHAT_MESSAGE_JSON_LIMIT,
  stripChatFileBase64,
  parseChatUploadFiles,
  parseStoredAttachments,
  toStoredAttachments,
  stringifyAttachments,
  toPublicAttachments,
  displayTextWithFiles,
  buildUploadedMessageContent,
  mapSessionMessage,
  toModelHistory,
};
