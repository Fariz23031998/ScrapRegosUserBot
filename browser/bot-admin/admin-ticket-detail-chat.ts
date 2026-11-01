declare var ticketUsers: any, userNames: any, ticketChatStatusEl: any, ticketChatCompose: any, ticketChatInput: any, ticketChatSendBtn: any, ticketChatFileInput: any, ticketChatAttachBtn: any, IMAGE_EXTENSIONS: any, AUDIO_EXTENSIONS: any, VIDEO_EXTENSIONS: any, pendingChatFiles: any, ticketChatPendingEl: any, MAX_CHAT_FILES: any, MAX_CHAT_FILE_BYTES: any, pendingChatFileSeq: any, ticketChatMessagesEl: any, currentTicketId: any;
declare function formatUnix(...args: any[]): any;
async function loadUsers() {
  try {
    const data = await api('/bot-admin/api/tickets/users');
    ticketUsers = data.users || [];
    userNames = {};
    for (const user of ticketUsers) {
      userNames[user.id] = user.full_name || user.login || `Пользователь #${user.id}`;
    }
  } catch {
    userNames = {};
    ticketUsers = [];
  }
}

function setChatStatus(message: any, { isError = false, loading = false }: any = {}) {
  if (!message) {
    ticketChatStatusEl.hidden = true;
    ticketChatStatusEl.textContent = '';
    ticketChatStatusEl.classList.remove('ticket-chat__status--error', 'ticket-chat__status--loading');
    return;
  }
  ticketChatStatusEl.hidden = false;
  ticketChatStatusEl.classList.toggle('ticket-chat__status--error', Boolean(isError));
  ticketChatStatusEl.classList.toggle('ticket-chat__status--loading', Boolean(loading) && !isError);
  if (loading && !isError) {
    ticketChatStatusEl.innerHTML = `
      <span class="process-spinner process-spinner--inline" aria-hidden="true"></span>
      <span>${escapeHtml(message)}</span>
    `;
  } else {
    ticketChatStatusEl.textContent = message;
  }
}

function setChatComposerEnabled(enabled: any) {
  const canSend = Boolean(enabled);
  ticketChatCompose.hidden = !canSend;
  ticketChatInput.disabled = !canSend;
  ticketChatSendBtn.disabled = !canSend;
  if (ticketChatFileInput) ticketChatFileInput.disabled = !canSend;
  if (ticketChatAttachBtn) ticketChatAttachBtn.disabled = !canSend;
  if (!canSend) {
    ticketChatInput.value = '';
    clearPendingChatFiles();
    setChatDropActive(false);
  }
}

function fileExtension(name: any) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase().slice(0, 10);
}

function chatFileExtension(file: any) {
  return String(file?.extension || fileExtension(file?.name || '')).replace(/^\./, '').toLowerCase();
}

function chatFileMime(file: any) {
  return String(file?.mime_type || file?.type || '').toLowerCase();
}

function chatFileMediaType(file: any) {
  return String(file?.media_type || '').toLowerCase();
}

function isChatImage(file: any) {
  const mediaType = chatFileMediaType(file);
  if (mediaType === 'image' || mediaType === 'photo' || mediaType === 'picture') return true;
  const mime = chatFileMime(file);
  if (mime.startsWith('image/')) return true;
  return IMAGE_EXTENSIONS.has(chatFileExtension(file));
}

function isChatAudio(file: any) {
  const mediaType = chatFileMediaType(file);
  if (mediaType === 'audio' || mediaType === 'voice') return true;
  const mime = chatFileMime(file);
  if (mime.startsWith('audio/')) return true;
  return AUDIO_EXTENSIONS.has(chatFileExtension(file));
}

function isChatVideo(file: any) {
  const mediaType = chatFileMediaType(file);
  if (mediaType === 'video') return true;
  const mime = chatFileMime(file);
  if (mime.startsWith('video/')) return true;
  return VIDEO_EXTENSIONS.has(chatFileExtension(file));
}

function chatFileMimeType(file: any) {
  const mime = chatFileMime(file);
  if (mime) return mime;
  const ext = chatFileExtension(file);
  if (isChatAudio(file)) {
    if (ext === 'mp3') return 'audio/mpeg';
    if (ext === 'ogg' || ext === 'oga') return 'audio/ogg';
    if (ext === 'wav') return 'audio/wav';
    if (ext === 'm4a') return 'audio/mp4';
    if (ext === 'aac') return 'audio/aac';
    if (ext === 'opus') return 'audio/opus';
    return 'audio/*';
  }
  if (isChatVideo(file)) {
    if (ext === 'mp4' || ext === 'm4v') return 'video/mp4';
    if (ext === 'webm') return 'video/webm';
    if (ext === 'mov') return 'video/quicktime';
    if (ext === 'ogv') return 'video/ogg';
    return 'video/*';
  }
  return '';
}

function formatFileSize(bytes: any) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} КБ`;
  return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
}

function fileToBase64(file: any) {
  return new Promise((resolve: any, reject: any) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать файл.'));
    reader.readAsDataURL(file);
  });
}

function filesFromDataTransfer(dataTransfer: any) {
  const files: any[] = [];
  const items = dataTransfer?.items;
  if (items && items.length) {
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
      if (entry && entry.isDirectory) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    return files;
  }
  return [...(dataTransfer?.files || [])];
}

function clearPendingChatFiles() {
  for (const item of pendingChatFiles) {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  }
  pendingChatFiles = [];
  renderPendingChatFiles();
}

function renderPendingChatFiles() {
  if (!ticketChatPendingEl) return;
  if (!pendingChatFiles.length) {
    ticketChatPendingEl.hidden = true;
    ticketChatPendingEl.innerHTML = '';
    return;
  }
  ticketChatPendingEl.hidden = false;
  ticketChatPendingEl.innerHTML = pendingChatFiles
    .map((item: any) => {
      const name = escapeHtml(item.file.name || 'файл');
      const thumb = item.previewUrl
        ? `<img class="ticket-chat__pending-thumb" src="${escapeHtml(item.previewUrl)}" alt="">`
        : '';
      const size = `<span class="ticket-chat__pending-size">${escapeHtml(formatFileSize(item.file.size))}</span>`;
      return `<div class="ticket-chat__pending-item">
        ${thumb}
        <span class="ticket-chat__pending-name" title="${name}">${name}</span>
        ${size}
        <button type="button" class="ticket-chat__pending-remove" data-pending-id="${item.id}" aria-label="Удалить файл">×</button>
      </div>`;
    })
    .join('');
}

function addPendingChatFiles(fileList: any) {
  const incoming = [...(fileList || [])].filter((file: any) => file && file.size > 0);
  if (!incoming.length) return;

  const remaining = MAX_CHAT_FILES - pendingChatFiles.length;
  if (remaining <= 0) {
    setChatStatus(`Можно прикрепить не больше ${MAX_CHAT_FILES} файлов.`, { isError: true });
    return;
  }

  const accepted: any[] = [];
  for (const file of incoming.slice(0, remaining)) {
    if (file.size > MAX_CHAT_FILE_BYTES) {
      setChatStatus('Файл слишком большой (максимум 10 МБ).', { isError: true });
      continue;
    }
    if (!fileExtension(file.name)) {
      setChatStatus('У файла должно быть расширение.', { isError: true });
      continue;
    }
    accepted.push({
      id: `pending-${++pendingChatFileSeq}`,
      file,
      previewUrl: isChatImage(file) ? URL.createObjectURL(file) : '',
    });
  }

  if (!accepted.length) return;
  pendingChatFiles = [...pendingChatFiles, ...accepted];
  renderPendingChatFiles();
  if (incoming.length > remaining) {
    setChatStatus(`Можно прикрепить не больше ${MAX_CHAT_FILES} файлов.`, { isError: true });
  }
}

function removePendingChatFile(pendingId: any) {
  const next: any[] = [];
  for (const item of pendingChatFiles) {
    if (String(item.id) === String(pendingId)) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      continue;
    }
    next.push(item);
  }
  pendingChatFiles = next;
  renderPendingChatFiles();
}

function setChatDropActive(active: any) {
  ticketChatCompose?.classList.toggle('ticket-chat__compose--drop', Boolean(active));
  ticketChatMessagesEl?.classList.toggle('ticket-chat__messages--drop', Boolean(active));
}

function chatFileProxyUrl(fileId: any) {
  return `/bot-admin/api/tickets/${encodeURIComponent(currentTicketId)}/files/${encodeURIComponent(fileId)}`;
}

function renderChatFiles(message: any) {
  const files =
    Array.isArray(message.files) && message.files.length
      ? message.files
      : (Array.isArray(message.file_ids) ? message.file_ids : []).map((id: any) => ({ id }));
  if (!files.length) return { html: '', count: 0 };

  const items = files
    .map((file: any) => {
      const id = file?.id;
      if (id == null || id === '') return '';
      const name =
        file.name ||
        (file.extension ? `файл.${String(file.extension).replace(/^\./, '')}` : `Файл ${id}`);
      const url = chatFileProxyUrl(id);
      if (isChatImage(file)) {
        return `<a class="ticket-chat__image-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
          <img class="ticket-chat__image" src="${escapeHtml(url)}" alt="${escapeHtml(name)}" loading="lazy">
        </a>`;
      }
      if (isChatAudio(file)) {
        return `<div class="ticket-chat__media ticket-chat__media--audio">
          <audio class="ticket-chat__audio" controls preload="metadata" src="${escapeHtml(url)}">
            Ваш браузер не поддерживает воспроизведение аудио.
          </audio>
          <a class="ticket-chat__media-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
            name
          )}</a>
        </div>`;
      }
      if (isChatVideo(file)) {
        return `<div class="ticket-chat__media ticket-chat__media--video">
          <video class="ticket-chat__video" controls preload="metadata" playsinline src="${escapeHtml(url)}">
            Ваш браузер не поддерживает воспроизведение видео.
          </video>
          <a class="ticket-chat__media-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
            name
          )}</a>
        </div>`;
      }
      const hasMetadata = Boolean(file.name || file.extension || file.mime_type || file.media_type);
      if (!hasMetadata) {
        return `<div class="ticket-chat__media ticket-chat__media--probe" data-url="${escapeHtml(url)}" data-name="${escapeHtml(name)}">
          <img class="ticket-chat__image ticket-chat__media-probe" src="${escapeHtml(url)}" alt="${escapeHtml(name)}" loading="lazy">
        </div>`;
      }
      return `<a class="ticket-chat__file-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
        name
      )}</a>`;
    })
    .filter(Boolean);

  return {
    html: items.length ? `<div class="ticket-chat__files">${items.join('')}</div>` : '',
    count: items.length,
  };
}

function chatAuthorBadge(message: any) {
  const messageType = String(message.message_type || '');
  if (messageType === 'System') {
    return { label: 'Система', className: 'ticket-chat__badge ticket-chat__badge--system' };
  }
  if (messageType === 'Private') {
    return { label: 'Приват', className: 'ticket-chat__badge ticket-chat__badge--private' };
  }
  const entityType = String(message.author_entity_type || '');
  const role = String(message.author_role || '');
  if (entityType === 'Client' || role === 'Member') {
    return { label: 'Клиент', className: 'ticket-chat__badge ticket-chat__badge--client' };
  }
  if (entityType === 'ChatBot' || role === 'Bot') {
    return { label: 'Бот', className: 'ticket-chat__badge ticket-chat__badge--bot' };
  }
  if (entityType === 'User' || role === 'Staff') {
    return { label: 'Сотрудник', className: 'ticket-chat__badge ticket-chat__badge--staff' };
  }
  return { label: entityType || role || 'Сообщение', className: 'ticket-chat__badge' };
}

function chatMessageClass(message: any) {
  const messageType = String(message.message_type || '');
  if (messageType === 'System') return 'ticket-chat__msg ticket-chat__msg--system';
  if (messageType === 'Private') return 'ticket-chat__msg ticket-chat__msg--private';
  const entityType = String(message.author_entity_type || '');
  const role = String(message.author_role || '');
  if (entityType === 'Client' || role === 'Member') {
    return 'ticket-chat__msg ticket-chat__msg--client';
  }
  if (entityType === 'ChatBot' || role === 'Bot') {
    return 'ticket-chat__msg ticket-chat__msg--bot';
  }
  if (entityType === 'User' || role === 'Staff') {
    return 'ticket-chat__msg ticket-chat__msg--staff';
  }
  return 'ticket-chat__msg';
}

function renderChatMessage(message: any) {
  const messageType = String(message.message_type || '');
  const isSystem = messageType === 'System';
  const badge = chatAuthorBadge(message);
  const author =
    message.author_entity_name ||
    (message.author_entity_id != null ? `ID ${message.author_entity_id}` : 'Неизвестный');
  const authorHtml = isSystem
    ? ''
    : `<span class="ticket-chat__author">${escapeHtml(author)}</span>`;
  const replyHtml =
    message.replay_text || message.reply_id
      ? `<div class="ticket-chat__reply">${escapeHtml(
          message.replay_text || `Ответ на ${message.reply_id}`
        )}</div>`
      : '';
  const files = renderChatFiles(message);
  const bodyText = String(message.display_text || message.text || '').trim();
  const text = bodyText
    ? `<p class="ticket-chat__text">${escapeHtml(bodyText)}</p>`
    : files.count
      ? ''
      : isSystem
        ? ''
        : `<p class="ticket-chat__text ticket-chat__text--empty">—</p>`;

  return `
    <article class="${chatMessageClass(message)}" data-message-id="${escapeHtml(String(message.id || ''))}">
      <div class="ticket-chat__meta${isSystem ? ' ticket-chat__meta--system' : ''}">
        ${authorHtml}
        <span class="${badge.className}">${escapeHtml(badge.label)}</span>
        <time datetime="${escapeHtml(String(message.created_date || ''))}">${escapeHtml(
          formatUnix(message.created_date)
        )}</time>
      </div>
      ${replyHtml}
      ${text}
      ${files.html}
    </article>
  `;
}
