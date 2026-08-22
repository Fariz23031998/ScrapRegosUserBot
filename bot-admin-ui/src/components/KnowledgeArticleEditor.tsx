import { Eye, ImagePlus, Pencil, type LucideIcon } from "lucide-react";
import { useRef, type ChangeEvent } from "react";
import MarkdownPreview from "./MarkdownPreview";
import type { KnowledgeArticle, KnowledgeCategory } from "../lib/types";

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
  pendingFiles: File[];
  editorPreview: boolean;
  onChange: (updater: (prev: Partial<KnowledgeArticle>) => Partial<KnowledgeArticle>) => void;
  onPreviewToggle: () => void;
  onPendingFilesChange: (files: File[]) => void;
  onUpload: (files: File[]) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export default function KnowledgeArticleEditor({
  editor,
  categories,
  formError,
  saving,
  uploading = false,
  pendingFiles,
  editorPreview,
  onChange,
  onPreviewToggle,
  onPendingFilesChange,
  onUpload,
  onClose,
  onSubmit,
}: KnowledgeArticleEditorProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const locked = Boolean(editor.locked);
  const busy = saving || uploading;

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
            rows={8}
            value={editor.body || ""}
            onChange={(event) => onChange((prev) => ({ ...prev, body: event.target.value }))}
            required
          />
        )}
      </div>
      {pendingFiles.length ? (
        <small>
          Скриншоты при сохранении: {pendingFiles.map((file) => file.name).join(", ")}
        </small>
      ) : null}
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
