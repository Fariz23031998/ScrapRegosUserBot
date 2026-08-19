import { renderMarkdown } from "../lib/markdown";

type MarkdownPreviewProps = {
  source: string;
  className?: string;
};

export default function MarkdownPreview({ source, className = "" }: MarkdownPreviewProps) {
  const html = renderMarkdown(source);
  if (!html) return <p className="empty-state">Нет текста.</p>;
  return (
    <div
      className={`markdown-preview${className ? ` ${className}` : ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
