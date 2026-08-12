import type { ChatFile, ChatMessage } from "./types";

export const CHAT_PAGE_LIMIT = 50;
export const MAX_CHAT_FILES = 5;
export const MAX_CHAT_FILE_BYTES = 10 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "ogg", "wav", "m4a", "aac", "opus", "oga", "weba"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "ogv", "avi", "mkv"]);

export function fileExtension(name: string): string {
  const base = String(name || "").split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase().slice(0, 10);
}

function chatFileExtension(file: ChatFile | File): string {
  if (file instanceof File) return fileExtension(file.name);
  return String(file.extension || fileExtension(file.name || ""))
    .replace(/^\./, "")
    .toLowerCase();
}

function chatFileMime(file: ChatFile | File): string {
  if (file instanceof File) return String(file.type || "").toLowerCase();
  return String(file.mime_type || file.mime || file.type || "").toLowerCase();
}

function chatFileMediaType(file: ChatFile | File): string {
  if (file instanceof File) return "";
  return String(file.media_type || "").toLowerCase();
}

export function isChatImage(file: ChatFile | File): boolean {
  const mediaType = chatFileMediaType(file);
  if (mediaType === "image" || mediaType === "photo" || mediaType === "picture") return true;
  const mime = chatFileMime(file);
  if (mime.startsWith("image/")) return true;
  return IMAGE_EXTENSIONS.has(chatFileExtension(file));
}

export function isChatAudio(file: ChatFile | File): boolean {
  const mediaType = chatFileMediaType(file);
  if (mediaType === "audio" || mediaType === "voice") return true;
  const mime = chatFileMime(file);
  if (mime.startsWith("audio/")) return true;
  return AUDIO_EXTENSIONS.has(chatFileExtension(file));
}

export function isChatVideo(file: ChatFile | File): boolean {
  const mediaType = chatFileMediaType(file);
  if (mediaType === "video") return true;
  const mime = chatFileMime(file);
  if (mime.startsWith("video/")) return true;
  return VIDEO_EXTENSIONS.has(chatFileExtension(file));
}

export function chatFileMimeType(file: ChatFile | File): string {
  const mime = chatFileMime(file);
  if (mime) return mime;
  const ext = chatFileExtension(file);
  if (isChatAudio(file)) {
    if (ext === "mp3") return "audio/mpeg";
    if (ext === "ogg" || ext === "oga") return "audio/ogg";
    if (ext === "wav") return "audio/wav";
    if (ext === "m4a") return "audio/mp4";
    if (ext === "aac") return "audio/aac";
    if (ext === "opus") return "audio/opus";
    return "audio/*";
  }
  if (isChatVideo(file)) {
    if (ext === "mp4" || ext === "m4v") return "video/mp4";
    if (ext === "webm") return "video/webm";
    if (ext === "mov") return "video/quicktime";
    if (ext === "ogv") return "video/ogg";
    return "video/*";
  }
  return "";
}

export function formatFileSize(bytes: number): string {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} КБ`;
  return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("Не удалось прочитать файл."));
    reader.readAsDataURL(file);
  });
}

export function filesFromDataTransfer(dataTransfer: DataTransfer | null): File[] {
  const files: File[] = [];
  const items = dataTransfer?.items;
  if (items && items.length) {
    for (const item of items) {
      if (item.kind !== "file") continue;
      const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
      if (entry && entry.isDirectory) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    return files;
  }
  return [...(dataTransfer?.files || [])];
}

export function chatAuthorBadge(message: ChatMessage): { label: string; className: string } {
  const messageType = String(message.message_type || "");
  if (messageType === "System") {
    return { label: "Система", className: "ticket-chat__badge ticket-chat__badge--system" };
  }
  if (messageType === "Private") {
    return { label: "Приват", className: "ticket-chat__badge ticket-chat__badge--private" };
  }
  const entityType = String(message.author_entity_type || "");
  const role = String(message.author_role || "");
  if (entityType === "Client" || role === "Member") {
    return { label: "Клиент", className: "ticket-chat__badge ticket-chat__badge--client" };
  }
  if (entityType === "ChatBot" || role === "Bot") {
    return { label: "Бот", className: "ticket-chat__badge ticket-chat__badge--bot" };
  }
  if (entityType === "User" || role === "Staff" || message.is_staff) {
    return { label: "Сотрудник", className: "ticket-chat__badge ticket-chat__badge--staff" };
  }
  return { label: entityType || role || "Сообщение", className: "ticket-chat__badge" };
}

export function chatMessageClass(message: ChatMessage): string {
  const messageType = String(message.message_type || "");
  if (messageType === "System") return "ticket-chat__msg ticket-chat__msg--system";
  if (messageType === "Private") return "ticket-chat__msg ticket-chat__msg--private";
  const entityType = String(message.author_entity_type || "");
  const role = String(message.author_role || "");
  if (entityType === "Client" || role === "Member") {
    return "ticket-chat__msg ticket-chat__msg--client";
  }
  if (entityType === "ChatBot" || role === "Bot") {
    return "ticket-chat__msg ticket-chat__msg--bot";
  }
  if (entityType === "User" || role === "Staff" || message.is_staff) {
    return "ticket-chat__msg ticket-chat__msg--staff";
  }
  return "ticket-chat__msg";
}

export function mergeMessages(
  existing: ChatMessage[],
  incoming: ChatMessage[],
  { prepend = false }: { prepend?: boolean } = {},
): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  const ordered = prepend ? [...incoming, ...existing] : [...existing, ...incoming];
  for (const message of ordered) {
    if (message?.id == null || message.id === "") continue;
    byId.set(String(message.id), message);
  }
  return [...byId.values()].sort((a, b) => {
    const dateA = Number(a.created_date) || 0;
    const dateB = Number(b.created_date) || 0;
    if (dateA !== dateB) return dateA - dateB;
    return String(a.id).localeCompare(String(b.id));
  });
}

export function chatFileDisplayName(file: ChatFile): string {
  if (file.name) return file.name;
  if (file.extension) return `файл.${String(file.extension).replace(/^\./, "")}`;
  return `Файл ${file.id}`;
}

export function chatFileHasMetadata(file: ChatFile): boolean {
  return Boolean(file.name || file.extension || file.mime_type || file.mime || file.media_type);
}
