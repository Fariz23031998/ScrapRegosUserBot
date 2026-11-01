const TELEGRAM_HTML = Object.freeze({ parse_mode: 'HTML' });

function escapeHtml(value?: any) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value?: any) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

function isSafeHttpUrl(url?: any) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function bold(text?: any) {
  return `<b>${escapeHtml(text)}</b>`;
}

function code(text?: any) {
  return `<code>${escapeHtml(text)}</code>`;
}

function field(emoji?: any, label?: any, value?: any) {
  const prefix = emoji ? `${emoji} ` : '';
  return `${prefix}<b>${escapeHtml(label)}:</b> ${escapeHtml(value)}`;
}

function link(url?: any, label?: any) {
  const href = String(url || '').trim();
  const text = label == null || label === '' ? href : String(label);
  if (!isSafeHttpUrl(href)) {
    return escapeHtml(text || href);
  }
  return `<a href="${escapeAttr(href)}">${escapeHtml(text)}</a>`;
}

/** Mutable HTML parse_mode options for node-telegram-bot-api (it assigns chat_id onto form). */
function withHtml(options?: any) {
  return { ...(options || {}), parse_mode: 'HTML' };
}

export {
  TELEGRAM_HTML,
  escapeHtml,
  bold,
  code,
  field,
  link,
  withHtml,
};
