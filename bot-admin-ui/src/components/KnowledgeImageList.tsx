import { ClipboardCopy, ImageOff, Link2, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { apiUrl } from "../lib/api-url";
import { knowledgeImageMarkdown, type KnowledgeImageRef } from "../lib/knowledge-image";
import ChatImagePreview from "./ChatImagePreview";

const EMPTY_IMAGES: KnowledgeImageRef[] = [];
const EMPTY_FILES: File[] = [];

function useFilePreviewUrls(files: File[]) {
  const [urls, setUrls] = useState<string[]>([]);
  const key = files.map((file) => `${file.name}:${file.size}:${file.lastModified}`).join("|");

  useEffect(() => {
    const created = files.map((file) => URL.createObjectURL(file));
    setUrls(created);
    return () => {
      created.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [key]);

  return urls;
}

type KnowledgeImageListProps = {
  images?: KnowledgeImageRef[];
  pendingFiles?: File[];
  canEdit?: boolean;
  deleting?: boolean;
  showInsert?: boolean;
  onInsert?: (markdown: string) => void;
  onDelete?: (imageId: number) => void;
  onRemovePending?: (index: number) => void;
};

export default function KnowledgeImageList({
  images = EMPTY_IMAGES,
  pendingFiles = EMPTY_FILES,
  canEdit = false,
  deleting = false,
  showInsert = false,
  onInsert,
  onDelete,
  onRemovePending,
}: KnowledgeImageListProps) {
  const previewUrls = useFilePreviewUrls(pendingFiles);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  if (!images.length && !pendingFiles.length) {
    return null;
  }

  async function copyUrl(image: KnowledgeImageRef) {
    try {
      await navigator.clipboard.writeText(image.url);
      setCopiedId(image.id);
      window.setTimeout(() => setCopiedId((prev) => (prev === image.id ? null : prev)), 2000);
    } catch {
      setCopiedId(null);
    }
  }

  return (
    <div className="knowledge-images">
      <div className="knowledge-images__head">
        <span>Скриншоты</span>
        <small>
          {images.length}
          {pendingFiles.length ? ` + ${pendingFiles.length}` : ""}
        </small>
      </div>
      <ul className="knowledge-images__list">
        {images.map((image) => {
          const name = image.original_name || `image-${image.id}`;
          return (
            <li key={image.id} className="knowledge-images__item">
              <ChatImagePreview
                url={apiUrl(image.url)}
                name={name}
                imgClassName="knowledge-images__thumb"
              />
              <div className="knowledge-images__meta">
                <span className="knowledge-images__name" title={name}>
                  {name}
                </span>
                <div className="knowledge-images__actions">
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => void copyUrl(image)}
                    title="Копировать URL"
                  >
                    <ClipboardCopy size={14} aria-hidden="true" />
                    {copiedId === image.id ? "Скопировано" : "URL"}
                  </button>
                  {showInsert && onInsert ? (
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() => onInsert(knowledgeImageMarkdown(image))}
                      title="Вставить в текст"
                    >
                      <Link2 size={14} aria-hidden="true" />
                      В текст
                    </button>
                  ) : null}
                  {canEdit && onDelete ? (
                    <button
                      type="button"
                      className="btn-danger btn-icon btn-sm"
                      aria-label="Удалить скриншот"
                      title="Удалить скриншот"
                      disabled={deleting}
                      onClick={() => onDelete(image.id)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
        {pendingFiles.map((file, index) => (
          <li key={`${file.name}-${file.size}-${file.lastModified}-${index}`} className="knowledge-images__item">
            {previewUrls[index] ? (
              <img className="knowledge-images__thumb" src={previewUrls[index]} alt={file.name} />
            ) : (
              <span className="knowledge-images__thumb knowledge-images__thumb--empty">
                <ImageOff size={18} aria-hidden="true" />
              </span>
            )}
            <div className="knowledge-images__meta">
              <span className="knowledge-images__name" title={file.name}>
                {file.name}
              </span>
              <div className="knowledge-images__actions">
                <small>При сохранении</small>
                {canEdit && onRemovePending ? (
                  <button
                    type="button"
                    className="btn-secondary btn-icon btn-sm"
                    aria-label="Убрать файл"
                    title="Убрать файл"
                    onClick={() => onRemovePending(index)}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
