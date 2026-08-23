import { Eye, ImagePlus, Pencil, type LucideIcon } from "lucide-react";
import { useRef, type ChangeEvent } from "react";
import { insertMarkdownAtCaret } from "../lib/knowledge-image";
import type { KnowledgeArticle, KnowledgeCategory } from "../lib/types";
import KnowledgeImageList from "./KnowledgeImageList";
import MarkdownPreview from "./MarkdownPreview";

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif";

function isImageFile(file: File) {
  if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) return true;
  return /\.(png|jpe?g|gif|webp)$/i.test(file.name);
}

function IconAction({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="btn-secondary btn-icon btn-sm"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon size={15} aria-hidden="true" />
    </button>
  );
}

type KnowledgeArticleEditorProps = {
  editor: Partial<KnowledgeArticle>;
  categories: KnowledgeCategory[];
  formError: string;
  saving: boolean;
  uploading?: boolean;
  deletingImage?: boolean;
  pendingFiles: File[];
  editorPreview: boolean;
  onChange: (updater: (prev: Partial<KnowledgeArticle>) => Partial<KnowledgeArticle>) => void;
  onPreviewToggle: () => void;
  onPendingFilesChange: (files: File[]) => void;
  onUpload: (files: File[]) => void;
  onDeleteImage?: (imageId: number) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export default function KnowledgeArticleEditor({
  editor,
  categories,
  formError,
  saving,
  uploading = false,
  deletingImage = false,
  pendingFiles,
  editorPreview,
  onChange,
  onPreviewToggle,
  onPendingFilesChange,
  onUpload,
  onDeleteImage,
  onClose,
  onSubmit,
}: KnowledgeArticleEditorProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const locked = Boolean(editor.locked);
  const busy = saving || uploading || deletingImage;
  const images = editor.images || [];

  function handleFiles(list: FileList | File[]) {
    const files = [...list].filter(isImageFile);
    if (!files.length || locked) return;
    if (editor.id) onUpload(files);
    else onPendingFilesChange([...pendingFiles, ...files]);
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    handleFiles(event.target.files || []);
    event.target.value = "";
  }

  function handleInsertMarkdown(markdown: string) {
    const node = bodyRef.current;
    const body = editor.body || "";
    const start = node?.selectionStart ?? body.length;
    const end = node?.selectionEnd ?? body.length;
    const next = insertMarkdownAtCaret(body, markdown, start, end);
    onChange((prev) => ({ ...prev, body: next.body }));
    requestAnimationFrame(() => {
      if (!bodyRef.current) return;
      bodyRef.current.focus();
      bodyRef.current.setSelectionRange(next.caret, next.caret);
    });
  }

  return (
    <form
      className="stack-form knowledge-article-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label>
        Заголовок
        <input
          value={editor.title || ""}
          onChange={(event) => onChange((prev) => ({ ...prev, title: event.target.value }))}
          required
        />
      </label>
      <label>
        Категория
        <select
          value={editor.category_id ?? ""}
          onChange={(event) => {
            const value = event.target.value;
            onChange((prev) => ({ ...prev, category_id: value ? Number(value) : null }));
          }}
        >
          <option value="">Без категории</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </label>
      <div className="knowledge-article-form__body">
        <div className="knowledge-article-form__body-head">
          <span>Текст (Markdown)</span>
          <div className="knowledge-article-form__body-actions">
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              multiple
              hidden
              onChange={handleFileInput}
            />
            <IconAction
              label="Добавить скриншот"
              icon={ImagePlus}
              onClick={() => {
                if (!locked && !busy) fileRef.current?.click();
              }}
            />
            <IconAction
              label={editorPreview ? "Редактировать" : "Просмотр"}
              icon={editorPreview ? Pencil : Eye}
              onClick={onPreviewToggle}
            />
          </div>
        </div>
        {editorPreview ? (
          <div className="knowledge-article-form__preview">
            <MarkdownPreview source={editor.body || ""} />
          </div>
        ) : (
          <textarea
            ref={bodyRef}
            rows={8}
            value={editor.body || ""}
            onChange={(event) => onChange((prev) => ({ ...prev, body: event.target.value }))}
            required
          />
        )}
      </div>
      <KnowledgeImageList
        images={images}
        pendingFiles={pendingFiles}
        canEdit={!locked}
        deleting={deletingImage}
        showInsert={!editorPreview && !locked}
        onInsert={handleInsertMarkdown}
        onDelete={onDeleteImage}
        onRemovePending={(index) => onPendingFilesChange(pendingFiles.filter((_, i) => i !== index))}
      />
      <label>
        Теги
        <input
          value={editor.tags || ""}
          onChange={(event) => onChange((prev) => ({ ...prev, tags: event.target.value }))}
        />
      </label>
      {editor.creator ? <small>Создал: {editor.creator}</small> : null}
      {formError ? <p className="message error">{formError}</p> : null}
      <div className="form-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Отмена
        </button>
        <button type="submit" className="btn-primary" disabled={busy || locked}>
          Сохранить
        </button>
      </div>
    </form>
  );
}
