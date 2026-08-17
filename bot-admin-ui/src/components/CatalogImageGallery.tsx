import { ImagePlus, X } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import ChatImagePreview from "./ChatImagePreview";
import { apiUrl } from "../lib/api-url";
import type { CatalogImage } from "../lib/types";

const MAX_IMAGES = 8;
const ACCEPT = "image/jpeg,image/png,image/webp,image/gif";

export function catalogImageSrc(url: string) {
  return apiUrl(url);
}

export function CatalogThumb({ images, alt }: { images?: CatalogImage[]; alt: string }) {
  const first = images?.[0];
  if (!first) return <span className="catalog-thumb catalog-thumb--empty" aria-hidden="true" />;
  return (
    <img
      className="catalog-thumb"
      src={catalogImageSrc(first.url)}
      alt={alt}
      crossOrigin="use-credentials"
    />
  );
}

type CatalogImageGalleryProps = {
  images?: CatalogImage[];
  alt: string;
  canEdit?: boolean;
  uploading?: boolean;
  variant?: "hero" | "compact";
  onUpload: (files: File[]) => void;
  onDelete?: (image: CatalogImage) => void;
};

export default function CatalogImageGallery({
  images = [],
  alt,
  canEdit = false,
  uploading = false,
  variant = "hero",
  onUpload,
  onDelete,
}: CatalogImageGalleryProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState<number | null>(images[0]?.id ?? null);
  const remaining = Math.max(0, MAX_IMAGES - images.length);
  const selected = images.find((image) => image.id === selectedId) || images[0] || null;

  useEffect(() => {
    if (!images.length) {
      setSelectedId(null);
      return;
    }
    if (!images.some((image) => image.id === selectedId)) {
      setSelectedId(images[0].id);
    }
  }, [images, selectedId]);

  function pickFiles() {
    if (!canEdit || remaining <= 0 || uploading) return;
    inputRef.current?.click();
  }

  function handleFiles(fileList: FileList | File[] | null) {
    if (!fileList) return;
    const files = Array.from(fileList).filter((file) => file.type.startsWith("image/")).slice(0, remaining);
    if (files.length) onUpload(files);
    if (inputRef.current) inputRef.current.value = "";
  }

  function onInputChange(event: ChangeEvent<HTMLInputElement>) {
    handleFiles(event.target.files);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    if (!canEdit || remaining <= 0 || uploading) return;
    handleFiles(event.dataTransfer.files);
  }

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept={ACCEPT}
      multiple
      hidden
      onChange={onInputChange}
    />
  );

  if (!images.length) {
    if (!canEdit) {
      return <div className={`catalog-gallery catalog-gallery--${variant} catalog-gallery--empty`}>Нет фото</div>;
    }
    return (
      <label
        className={`catalog-gallery catalog-gallery--${variant} catalog-gallery--drop`}
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
      >
        {fileInput}
        <span className="catalog-gallery__drop-copy">
          <ImagePlus size={22} aria-hidden="true" />
          {uploading ? "Загрузка…" : "Добавить фото"}
        </span>
      </label>
    );
  }

  return (
    <div className={`catalog-gallery catalog-gallery--${variant}`}>
      {fileInput}
      <div className="catalog-gallery__hero">
        {selected ? (
          <ChatImagePreview
            url={catalogImageSrc(selected.url)}
            name={selected.original_name || alt}
            imgClassName="catalog-gallery__hero-img"
          />
        ) : null}
        {canEdit && remaining > 0 ? (
          <button type="button" className="catalog-gallery__add" onClick={pickFiles} disabled={uploading}>
            <ImagePlus size={16} aria-hidden="true" />
            {uploading ? "Загрузка…" : "Добавить"}
          </button>
        ) : null}
        {canEdit && selected && onDelete && images.length === 1 ? (
          <button
            type="button"
            className="catalog-gallery__hero-delete"
            aria-label="Удалить фото"
            onClick={() => onDelete(selected)}
            disabled={uploading}
          >
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {images.length > 1 ? (
        <div className="catalog-gallery__thumbs">
          {images.map((image) => (
            <div key={image.id} className="catalog-gallery__thumb-wrap">
              <button
                type="button"
                className={`catalog-gallery__thumb${image.id === selected?.id ? " is-active" : ""}`}
                onClick={() => setSelectedId(image.id)}
              >
                <img src={catalogImageSrc(image.url)} alt="" crossOrigin="use-credentials" />
              </button>
              {canEdit && onDelete ? (
                <button
                  type="button"
                  className="catalog-gallery__thumb-delete"
                  aria-label="Удалить фото"
                  onClick={() => onDelete(image)}
                  disabled={uploading}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
