import { useEffect, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { CatalogCategory } from "../lib/types";
import Modal from "./Modal";

type CatalogCategoryManagerProps = {
  open: boolean;
  categories: CatalogCategory[];
  isLoading?: boolean;
  canEdit: boolean;
  onClose: () => void;
  onSave: (payload: { id?: number; name: string }) => Promise<void>;
  onDelete: (category: CatalogCategory) => void;
};

export default function CatalogCategoryManager({
  open,
  categories,
  isLoading = false,
  canEdit,
  onClose,
  onSave,
  onDelete,
}: CatalogCategoryManagerProps) {
  const [editor, setEditor] = useState<{ id?: number; name: string } | null>(null);
  const [formError, setFormError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) {
      setEditor(null);
      setFormError("");
      setPending(false);
    }
  }, [open]);

  return (
    <>
      <Modal open={open} title="Категории" onClose={onClose}>
        <div className="knowledge-category-manager">
          {canEdit ? (
            <div className="form-actions">
              <button
                type="button"
                className="btn-primary btn-sm"
                onClick={() => {
                  setFormError("");
                  setEditor({ name: "" });
                }}
              >
                Новая категория
              </button>
            </div>
          ) : null}
          {isLoading ? (
            <p>Загрузка…</p>
          ) : !categories.length ? (
            <p className="empty-state">Категорий нет.</p>
          ) : (
            <ul className="knowledge-category-list">
              {categories.map((category) => (
                <li key={category.id} className="knowledge-category-list__item">
                  <div>
                    <strong>{category.name}</strong>
                  </div>
                  {canEdit ? (
                    <div className="cell-actions">
                      <button
                        type="button"
                        className="btn-secondary btn-icon btn-sm"
                        aria-label="Изменить"
                        title="Изменить"
                        onClick={() => {
                          setFormError("");
                          setEditor({ id: category.id, name: category.name });
                        }}
                      >
                        <Pencil size={15} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="btn-danger btn-icon btn-sm"
                        aria-label="Удалить"
                        title="Удалить"
                        onClick={() => onDelete(category)}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>

      <Modal
        open={editor != null}
        title={editor?.id ? "Редактирование категории" : "Новая категория"}
        onClose={() => setEditor(null)}
      >
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!editor) return;
            setFormError("");
            setPending(true);
            void onSave({ id: editor.id, name: editor.name.trim() })
              .then(() => setEditor(null))
              .catch((error: unknown) => {
                setFormError(error instanceof Error ? error.message : "Не удалось сохранить категорию.");
              })
              .finally(() => setPending(false));
          }}
        >
          <label>
            Название
            <input
              required
              maxLength={100}
              value={editor?.name || ""}
              onChange={(event) =>
                setEditor((prev) => (prev ? { ...prev, name: event.target.value } : prev))
              }
            />
          </label>
          {formError ? <p className="message error">{formError}</p> : null}
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setEditor(null)}>
              Отмена
            </button>
            <button type="submit" className="btn-primary" disabled={pending}>
              Сохранить
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
