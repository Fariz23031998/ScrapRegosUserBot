declare var STATUS_LABELS: any, DIRECTION_LABELS: any;
declare function pad2(...args: any[]): any;
declare var ticketsWrap: any, recordingDurationCache: any, recordingDurationPromises: any, durationLoadGeneration: any, tickets: any;
declare var recordingModalTrigger: any, recordingModalTicket: any, recordingPlayer: any, recordingModal: any, recordingModalClose: any;
function statusLabel(status: any) {
  return STATUS_LABELS[status] || status || '—';
}

function directionLabel(direction: any) {
  return DIRECTION_LABELS[direction] || direction || '—';
}

function getCachedRecording(ticket: any) {
  return ticket?.local?.recording || null;
}

function getCachedRecordingDuration(ticket: any) {
  const duration = Number(getCachedRecording(ticket)?.duration_seconds);
  // 0 is not a usable duration (failed server parse); keep probing via Audio.
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function getRecordingUrl(ticket: any) {
  const cachedUrl = String(getCachedRecording(ticket)?.url || '').trim();
  if (/^https?:\/\//i.test(cachedUrl)) return cachedUrl;

  const fields = Array.isArray(ticket?.fields) ? ticket.fields : [];
  const recordingField = fields.find((field: any) => {
    const key = String(field?.key || '').trim().toLowerCase();
    const name = String(field?.name || '').trim().toLowerCase();
    return key === 'field_recording_link' || name === 'ссылка на запись';
  });
  const value = String(recordingField?.value || '').trim();
  return /^https?:\/\//i.test(value) ? value : null;
}

function getRecordingMediaUrl(ticket: any) {
  return `/bot-admin/api/tickets/${encodeURIComponent(ticket.id)}/recording`;
}

function formatCallDuration(totalSeconds: any) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds)));
  if (!Number.isFinite(seconds)) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(remainder)}`
    : `${minutes}:${pad2(remainder)}`;
}

function setDurationCell(index: any, duration: any) {
  const cell = ticketsWrap.querySelector(`[data-call-duration-index="${index}"]`);
  if (cell) cell.textContent = formatCallDuration(duration);
}

function loadRecordingDuration(ticketId: any) {
  const key = String(ticketId);
  if (recordingDurationCache.has(key)) {
    return Promise.resolve(recordingDurationCache.get(key));
  }
  if (recordingDurationPromises.has(key)) {
    return recordingDurationPromises.get(key);
  }

  const promise = new Promise((resolve: any) => {
    const audio = new Audio();
    audio.preload = 'metadata';
    const timeout = setTimeout(() => finish(null), 15_000);

    function finish(duration: any) {
      clearTimeout(timeout);
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('error', onError);
      audio.removeAttribute('src');
      audio.load();
      if (Number.isFinite(duration)) {
        recordingDurationCache.set(key, duration);
        resolve(duration);
      } else {
        resolve(null);
      }
    }

    function onLoaded() {
      const duration = Number(audio.duration);
      finish(Number.isFinite(duration) && duration > 0 ? duration : null);
    }

    function onError() {
      finish(null);
    }

    audio.addEventListener('loadedmetadata', onLoaded, { once: true });
    audio.addEventListener('error', onError, { once: true });
    audio.src = `/bot-admin/api/tickets/${encodeURIComponent(ticketId)}/recording`;
  }).finally(() => recordingDurationPromises.delete(key));

  recordingDurationPromises.set(key, promise);
  return promise;
}

function loadVisibleCallDurations() {
  const generation = ++durationLoadGeneration;
  tickets.forEach((ticket: any, index: any) => {
    const cachedDuration = getCachedRecordingDuration(ticket);
    if (Number.isFinite(cachedDuration)) {
      recordingDurationCache.set(String(ticket.id), cachedDuration);
      setDurationCell(index, cachedDuration);
      return;
    }
    const recordingUrl = getRecordingUrl(ticket);
    if (!recordingUrl) return;
    loadRecordingDuration(ticket.id).then((duration: any) => {
      if (generation === durationLoadGeneration && Number.isFinite(duration)) {
        setDurationCell(index, duration);
      }
    });
  });
}

function openRecordingModal(ticket: any, trigger: any) {
  if (!getRecordingUrl(ticket)) return;
  recordingModalTrigger = trigger || null;
  recordingModalTicket.textContent = `Тикет #${ticket.id} — ${ticket.subject || 'Без темы'}`;
  recordingPlayer.src = getRecordingMediaUrl(ticket);
  recordingModal.hidden = false;
  document.documentElement.classList.add('modal-open');
  document.body.classList.add('modal-open');
  recordingModalClose.focus();
}

function closeRecordingModal() {
  if (recordingModal.hidden) return;
  recordingPlayer.pause();
  recordingPlayer.removeAttribute('src');
  recordingPlayer.load();
  recordingModal.hidden = true;
  document.documentElement.classList.remove('modal-open');
  document.body.classList.remove('modal-open');
  recordingModalTrigger?.focus();
  recordingModalTrigger = null;
}
