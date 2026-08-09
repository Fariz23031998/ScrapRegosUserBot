const TELEGRAM_HTML = Object.freeze({ parse_mode: 'HTML' });

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

function isSafeHttpUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function bold(text) {
  return `<b>${escapeHtml(text)}</b>`;
}

function code(text) {
  return `<code>${escapeHtml(text)}</code>`;
}

function field(emoji, label, value) {
  const prefix = emoji ? `${emoji} ` : '';
  return `${prefix}<b>${escapeHtml(label)}:</b> ${escapeHtml(value)}`;
}

function link(url, label) {
  const href = String(url || '').trim();
  const text = label == null || label === '' ? href : String(label);
  if (!isSafeHttpUrl(href)) {
    return escapeHtml(text || href);
  }
  return `<a href="${escapeAttr(href)}">${escapeHtml(text)}</a>`;
}

function withHtml(options) {
  return { ...(options || {}), parse_mode: 'HTML' };
}

module.exports = {
  TELEGRAM_HTML,
  escapeHtml,
  bold,
  code,
  field,
  link,
  withHtml,
};
