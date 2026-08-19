import { escapeHtml } from "./utils";

const SLOT = (index: number) => `\u0000MD${index}\u0000`;

function restoreSlots(html: string, slots: string[]): string {
  return html.replace(/\u0000MD(\d+)\u0000/g, (_match, raw) => slots[Number(raw)] || "");
}

function safeHref(escapedHref: string): string | null {
  const href = String(escapedHref || "").replace(/&amp;/g, "&");
  if (!/^https?:\/\//i.test(href)) return null;
  return escapeHtml(href);
}

/** Escape user text, then apply a small Markdown subset (headings, lists, links, emphasis, code). */
export function renderMarkdown(source: string): string {
  const raw = String(source || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return "";

  const slots: string[] = [];
  const stash = (html: string) => {
    const index = slots.length;
    slots.push(html);
    return SLOT(index);
  };

  let text = escapeHtml(raw);

  text = text.replace(/```(?:[a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (_match, code) =>
    stash(`<pre><code>${String(code).replace(/\n$/, "")}</code></pre>`),
  );
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => stash(`<code>${code}</code>`));
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, hrefEscaped) => {
    const href = safeHref(hrefEscaped);
    if (!href) return label;
    return stash(`<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");

  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${heading[2]}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${lines[i].replace(/^\s*[-*]\s+/, "")}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${lines[i].replace(/^\s*\d+\.\s+/, "")}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${para.join("<br />")}</p>`);
  }

  return restoreSlots(out.join(""), slots);
}
