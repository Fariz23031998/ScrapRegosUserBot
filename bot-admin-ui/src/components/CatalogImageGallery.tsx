import { ImageOff, ImagePlus, X } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import ChatImagePreview from "./ChatImagePreview";
import { apiUrl } from "../lib/api-url";
import type { CatalogImage } from "../lib/types";

const MAX_IMAGES = 8;
const ACCEPT = "image/jpeg,image/png,image/webp,image/gif";
const EMPTY_IMAGES: CatalogImage[] = [];
const EMPTY_FILES: File[] = [];

export function catalogImageSrc(url: string) {
  return apiUrl(url);
}

export function CatalogThumb({ images, alt }: { images?: CatalogImage[]; alt: string }) {
  const first = images?.[0];
  if (!first) {
    return (
      <span className="catalog-thumb catalog-thumb--empty" title="Нет фото" aria-label="Нет фото">
        <ImageOff size={18} aria-hidden="true" />
      </span>
    );
  }
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
  pendingFiles?: File[];
  alt: string;
  canEdit?: boolean;
  uploading?: boolean;
  variant?: "hero" | "compact";
  onUpload?: (files: File[]) => void;
  onPendingFilesChange?: (files: File[]) => void;
  onDelete?: (image: CatalogImage) => void;
};

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

export default function CatalogImageGallery({
  images = EMPTY_IMAGES,
  pendingFiles = EMPTY_FILES,
  alt,
  canEdit = false,
  uploading = false,
  variant = "hero",
  onUpload,
  onPendingFilesChange,
  onDelete,
}: CatalogImageGalleryProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrls = useFilePreviewUrls(pendingFiles);
  const [selectedId, setSelectedId] = useState<number | null>(images[0]?.id ?? null);
  const [selectedPending, setSelectedPending] = useState(0);
  const remaining = Math.max(0, MAX_IMAGES - images.length - pendingFiles.length);
  const selected = images.find((image) => image.id === selectedId) || images[0] || null;
  const selectedPendingUrl = previewUrls[selectedPending] || previewUrls[0] || "";
  const selectedPendingFile = pendingFiles[selectedPending] || pendingFiles[0] || null;
  const showPending = !images.length && pendingFiles.length > 0;

  useEffect(() => {
    if (!images.length) {
      setSelectedId(null);
      return;
    }
    if (!images.some((image) => image.id === selectedId)) {
      setSelectedId(images[0].id);
    }
  }, [images, selectedId]);

  useEffect(() => {
    if (selectedPending >= pendingFiles.length) {
      setSelectedPending(Math.max(0, pendingFiles.length - 1));
    }
  }, [pendingFiles.length, selectedPending]);

  function pickFiles() {
    if (!canEdit || remaining <= 0 || uploading) return;
    inputRef.current?.click();
  }

  function handleFiles(fileList: FileList | File[] | null) {
    if (!fileList) return;
    const files = Array.from(fileList).filter((file) => file.type.startsWith("image/")).slice(0, remaining);
    if (files.length) {
      if (onPendingFilesChange) {
        onPendingFilesChange([...pendingFiles, ...files].slice(0, MAX_IMAGES));
      } else if (onUpload) {
        onUpload(files);
      }
    }
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

  function removePending(index: number) {
    if (!onPendingFilesChange) return;
    onPendingFilesChange(pendingFiles.filter((_, itemIndex) => itemIndex !== index));
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

  const addHint = remaining > 1 ? "Можно выбрать несколько" : remaining === 1 ? "Можно добавить ещё одно" : "";

  if (!images.length && !pendingFiles.length) {
    if (!canEdit) {
      return (
        <div className={`catalog-gallery catalog-gallery--${variant} catalog-gallery--empty`}>
          <span className="catalog-gallery__drop-copy">
            <ImageOff size={22} aria-hidden="true" />
            Нет фото
          </span>
        </div>
      );
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
          {addHint ? <small>{addHint}</small> : null}
        </span>
      </label>
    );
  }

  if (showPending) {
    return (
      <div className={`catalog-gallery catalog-gallery--${variant}`}>
        {fileInput}
        <div className="catalog-gallery__hero">
          {selectedPendingUrl ? (
            <img className="catalog-gallery__hero-img" src={selectedPendingUrl} alt={selectedPendingFile?.name || alt} />
          ) : null}
          {canEdit && remaining > 0 ? (
            <button type="button" className="catalog-gallery__add" onClick={pickFiles} disabled={uploading}>
              <ImagePlus size={16} aria-hidden="true" />
              {uploading ? "Загрузка…" : "Добавить"}
            </button>
          ) : null}
          {canEdit && pendingFiles.length === 1 ? (
            <button
              type="button"
              className="catalog-gallery__hero-delete"
              aria-label="Удалить фото"
              onClick={() => removePending(0)}
              disabled={uploading}
            >
              <X size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {pendingFiles.length > 1 ? (
          <div className="catalog-gallery__thumbs">
            {pendingFiles.map((file, index) => (
              <div key={`${file.name}-${file.size}-${file.lastModified}-${index}`} className="catalog-gallery__thumb-wrap">
                <button
                  type="button"
                  className={`catalog-gallery__thumb${index === selectedPending ? " is-active" : ""}`}
                  onClick={() => setSelectedPending(index)}
                >
                  {previewUrls[index] ? <img src={previewUrls[index]} alt="" /> : null}
                </button>
                {canEdit ? (
                  <button
                    type="button"
                    className="catalog-gallery__thumb-delete"
                    aria-label="Удалить фото"
                    onClick={() => removePending(index)}
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
