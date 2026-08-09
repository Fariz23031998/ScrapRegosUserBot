const DEFAULT_RECORDING_HOSTS = ['rofeev.7x.uz'];

function getAllowedRecordingHosts() {
  const configured = String(process.env.REGOS_RECORDING_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return new Set(configured.length ? configured : DEFAULT_RECORDING_HOSTS);
}

function getTicketRecordingUrl(ticket) {
  const fields = Array.isArray(ticket?.fields) ? ticket.fields : [];
  const recordingField = fields.find((field) => {
    const key = String(field?.key || '').trim().toLowerCase();
    const name = String(field?.name || '').trim().toLowerCase();
    return key === 'field_recording_link' || name === 'ссылка на запись';
  });
  const value = String(recordingField?.value || '').trim();
  if (!value) return null;

  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (!getAllowedRecordingHosts().has(url.host.toLowerCase())) return null;
    return url;
  } catch {
    return null;
  }
}

module.exports = {
  DEFAULT_RECORDING_HOSTS,
  getAllowedRecordingHosts,
  getTicketRecordingUrl,
};
