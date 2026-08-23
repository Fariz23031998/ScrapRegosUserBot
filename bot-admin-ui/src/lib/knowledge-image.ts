export type KnowledgeImageRef = {
  id: number;
  url: string;
  original_name?: string;
};

export function escapeKnowledgeImageAlt(value: string): string {
  return String(value || "")
    .replace(/[\[\]]/g, "")
    .replace(/\r?\n/g, " ")
    .trim()
    .slice(0, 120);
}

export function knowledgeImageMarkdown(image: KnowledgeImageRef, alt?: string): string {
  const label =
    escapeKnowledgeImageAlt(alt || image.original_name || "screenshot") || "screenshot";
  return `![${label}](${image.url})`;
}

export function insertMarkdownAtCaret(
  body: string,
  markdown: string,
  selectionStart: number,
  selectionEnd: number,
): { body: string; caret: number } {
  const start = Math.max(0, Math.min(selectionStart, body.length));
  const end = Math.max(start, Math.min(selectionEnd, body.length));
  const before = body.slice(0, start);
  const after = body.slice(end);
  const needsLeadingNewline = before.length > 0 && !/\n\n$/.test(before) && !before.endsWith("\n");
  const prefix = before.length === 0 ? "" : needsLeadingNewline ? "\n\n" : before.endsWith("\n") && !before.endsWith("\n\n") ? "\n" : "";
  const needsTrailingNewline = after.length > 0 && !after.startsWith("\n");
  const suffix = needsTrailingNewline ? "\n\n" : "";
  const inserted = `${prefix}${markdown}${suffix}`;
  const nextBody = `${before}${inserted}${after}`;
  return { body: nextBody, caret: before.length + inserted.length };
}
