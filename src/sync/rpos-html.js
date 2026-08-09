/**
 * Parse Django admin changelist HTML without a browser.
 */

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

function stripTags(html) {
  return decodeHtmlEntities(String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}

function parseAdminTableHtml(html) {
  const tableMatch = String(html || '').match(
    /<table[^>]*id=["']result_list["'][^>]*>([\s\S]*?)<\/table>/i
  );
  if (!tableMatch) {
    return { headers: [], rows: [] };
  }

  const tableHtml = tableMatch[1];
  const headerCells = [...tableHtml.matchAll(/<thead[\s\S]*?<tr[\s\S]*?>([\s\S]*?)<\/tr>/gi)];
  let headers = [];
  if (headerCells[0]) {
    headers = [...headerCells[0][1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) =>
      stripTags(m[1])
    );
  }

  const bodyMatch = tableHtml.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : tableHtml;
  const rows = [];
  for (const rowMatch of bodyHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map((m) =>
      stripTags(m[1])
    );
    if (cells.length) rows.push(cells);
  }

  return { headers, rows };
}

function isRposLoginHtml(html, url) {
  const href = String(url || '');
  const body = String(html || '');
  if (href.includes('/login')) return true;
  return body.includes('id_username') && body.includes('csrfmiddlewaretoken');
}

module.exports = {
  decodeHtmlEntities,
  stripTags,
  parseAdminTableHtml,
  isRposLoginHtml,
};
