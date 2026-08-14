const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg']);
const VISION_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
const VISION_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'ogg', 'wav', 'm4a', 'aac', 'opus', 'oga', 'weba']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'avi', 'mkv']);

const MAX_INLINE_IMAGES = 3;
const MAX_INLINE_AUDIO = 3;
const MAX_SUMMARY_AUDIO = 5;
const MAX_SUMMARY_IMAGES = 5;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_AUDIO_FILE_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 12_000;
const IMAGE_AGENT_TIMEOUT_MS = 90_000;
const AUDIO_AGENT_TIMEOUT_MS = 90_000;
const REASONING_AGENT_TIMEOUT_MS = 90_000;

const KIND_LABELS = {
  image: 'изображение',
  audio: 'аудио',
  video: 'видео',
  file: 'файл',
};

function fileExtension(file) {
  const fromField = String(file?.extension || '')
    .trim()
    .replace(/^\./, '')
    .toLowerCase();
  if (fromField) return fromField;
  const name = String(file?.name || '').split(/[\\/]/).pop() || '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

function fileMime(file) {
  return String(file?.mime_type || file?.mime || file?.type || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

function fileMediaType(file) {
  return String(file?.media_type || '').trim().toLowerCase();
}

function isChatImage(file) {
  const mediaType = fileMediaType(file);
  if (mediaType === 'image' || mediaType === 'photo' || mediaType === 'picture') return true;
  const mime = fileMime(file);
  if (mime.startsWith('image/')) return true;
  return IMAGE_EXTENSIONS.has(fileExtension(file));
}

function isChatAudio(file) {
  const mediaType = fileMediaType(file);
  if (mediaType === 'audio' || mediaType === 'voice') return true;
  const mime = fileMime(file);
  if (mime.startsWith('audio/')) return true;
  return AUDIO_EXTENSIONS.has(fileExtension(file));
}

function isChatVideo(file) {
  const mediaType = fileMediaType(file);
  if (mediaType === 'video') return true;
  const mime = fileMime(file);
  if (mime.startsWith('video/')) return true;
  return VIDEO_EXTENSIONS.has(fileExtension(file));
}

function isVisionImage(file) {
  if (!isChatImage(file)) return false;
  const mime = fileMime(file);
  if (mime === 'image/svg+xml' || mime === 'image/bmp' || mime === 'image/x-ms-bmp') return false;
  const ext = fileExtension(file);
  if (ext === 'svg' || ext === 'bmp') return false;
  if (mime.startsWith('image/') && !VISION_MIMES.has(mime)) return false;
  if (ext && !VISION_EXTENSIONS.has(ext) && !mime.startsWith('image/')) return false;
  return true;
}

function classifyChatFile(file) {
  if (isChatImage(file)) return 'image';
  if (isChatAudio(file)) return 'audio';
  if (isChatVideo(file)) return 'video';
  return 'file';
}

function fileDisplayName(file) {
  const name = String(file?.name || '').trim();
  if (name) return name;
  const ext = fileExtension(file);
  if (file?.id != null && ext) return `file-${file.id}.${ext}`;
  if (file?.id != null) return `file-${file.id}`;
  return ext ? `file.${ext}` : 'file';
}

function compactChatFile(file) {
  if (!file || file.id == null) return null;
  const id = Number(file.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return {
    id,
    name: fileDisplayName(file),
    kind: classifyChatFile(file),
  };
}

function formatFileStub(file) {
  const kind = classifyChatFile(file);
  const label = KIND_LABELS[kind] || KIND_LABELS.file;
  const name = fileDisplayName(file);
  const id = file?.id != null ? ` #${file.id}` : '';
  return `[${label}: ${name}${id}]`;
}

function collectMessageFileIds(messages) {
  const ids = [];
  const seen = new Set();
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

function messageFileIds(message) {
  return collectMessageFileIds([message]);
}

function isSafeFileUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function visionMimeForFile(file, headerMime) {
  const mime = String(fileMime(file) || headerMime || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (VISION_MIMES.has(mime)) return mime === 'image/jpg' ? 'image/jpeg' : mime;
  const ext = fileExtension(file);
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

function toImageUrlPart({ mime, base64 } = {}) {
  const data = String(base64 || '').trim();
  if (!data) return null;
  const safeMime = String(mime || 'image/jpeg').split(';')[0].trim() || 'image/jpeg';
  return {
    type: 'image_url',
    image_url: { url: `data:${safeMime};base64,${data}` },
  };
}

async function downloadChatFileBytes(
  file,
  { fetchImpl = fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS, maxBytes = MAX_FILE_BYTES } = {}
) {
  const url = String(file?.url || '').trim();
  if (!isSafeFileUrl(url)) return { skipped: true, reason: 'unsafe_url' };

  const limit = Math.max(1, Number(maxBytes) || MAX_FILE_BYTES);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DOWNLOAD_TIMEOUT_MS));
  try {
    const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal });
    if (!response || !response.ok) {
      return { skipped: true, reason: `http_${response?.status || 0}` };
    }

    const contentLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(contentLength) && contentLength > limit) {
      return { skipped: true, reason: 'too_large' };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) return { skipped: true, reason: 'empty' };
    if (buffer.length > limit) return { skipped: true, reason: 'too_large' };

    const headerMime = response.headers?.get?.('content-type') || '';
    return {
      buffer,
      mime: String(headerMime || fileMime(file) || '')
        .split(';')[0]
        .trim(),
      bytes: buffer.length,
    };
  } catch (error) {
    if (error?.name === 'AbortError') return { skipped: true, reason: 'timeout' };
    return { skipped: true, reason: 'download_failed' };
  } finally {
    clearTimeout(timer);
  }
}

async function downloadChatFile(file, { fetchImpl = fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  const downloaded = await downloadChatFileBytes(file, { fetchImpl, timeoutMs, maxBytes: MAX_FILE_BYTES });
  if (downloaded?.skipped || !downloaded?.buffer) return downloaded;
  return {
    mime: visionMimeForFile(file, downloaded.mime),
    base64: downloaded.buffer.toString('base64'),
    bytes: downloaded.bytes,
  };
}

function historyHasVisionParts(messages) {
  return (messages || []).some(
    (message) =>
      Array.isArray(message?.content) && message.content.some((part) => part?.type === 'image_url')
  );
}

function messageContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : part?.text || ''))
    .filter(Boolean)
    .join('\n');
}

function historyHasAudioTranscript(messages) {
  return (messages || []).some((message) => /Расшифровка:/.test(messageContentText(message?.content)));
}

module.exports = {
  MAX_INLINE_IMAGES,
  MAX_INLINE_AUDIO,
  MAX_SUMMARY_AUDIO,
  MAX_SUMMARY_IMAGES,
  MAX_FILE_BYTES,
  MAX_AUDIO_FILE_BYTES,
  DOWNLOAD_TIMEOUT_MS,
  IMAGE_AGENT_TIMEOUT_MS,
  AUDIO_AGENT_TIMEOUT_MS,
  REASONING_AGENT_TIMEOUT_MS,
  isChatImage,
  isChatAudio,
  isChatVideo,
  isVisionImage,
  classifyChatFile,
  compactChatFile,
  formatFileStub,
  collectMessageFileIds,
  messageFileIds,
  isSafeFileUrl,
  downloadChatFile,
  downloadChatFileBytes,
  toImageUrlPart,
  historyHasVisionParts,
  historyHasAudioTranscript,
  fileDisplayName,
  visionMimeForFile,
};
