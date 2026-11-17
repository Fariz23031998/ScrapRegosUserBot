import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookText, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  createQuickText,
  deleteQuickText,
  insertQuickTextIntoCompose,
  listQuickTexts,
  updateQuickText,
} from "../api/quick-texts";
import { useConfirm } from "../contexts/ConfirmContext";
import type { EmployeeQuickText, EmployeeQuickTextKind } from "../lib/types";

type QuickTextPickerProps = {
  kind: EmployeeQuickTextKind;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
  manageLabel?: string;
  emptyLabel?: string;
};

function itemLabel(item: EmployeeQuickText): string {
  const title = item.title?.trim();
  if (title) return title;
  const body = item.body.trim().replace(/\s+/g, " ");
  return body.length > 60 ? `${body.slice(0, 57)}…` : body || "Без текста";
}

export default function QuickTextPicker({
  kind,
  value,
  onChange,
  disabled = false,
  label = "Шаблоны",
  manageLabel = "Управление",
  emptyLabel = "Пока нет сохранённых текстов.",
}: QuickTextPickerProps) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [formError, setFormError] = useState("");

  const queryKey = ["employee-quick-texts", kind];
  const listQuery = useQuery({
    queryKey,
    queryFn: async () => (await listQuickTexts(kind)).items,
    enabled: open,
  });

  const items = listQuery.data || [];

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setManaging(false);
        setEditingId(null);
        setFormError("");
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function resetForm() {
    setEditingId(null);
    setTitle("");
    setBody("");
    setFormError("");
  }

  function startCreate() {
    setManaging(true);
    setEditingId(null);
    setTitle("");
    setBody("");
    setFormError("");
  }

  function startEdit(item: EmployeeQuickText) {
    setManaging(true);
    setEditingId(item.id);
    setTitle(item.title || "");
    setBody(item.body);
    setFormError("");
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = { title: title.trim() || null, body: body.trim() };
      if (editingId != null) {
        return updateQuickText(kind, editingId, payload);
      }
      return createQuickText(kind, payload);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
      resetForm();
      setManaging(true);
    },
    onError: (error: Error) => {
      setFormError(error.message || "Ошибка сохранения");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteQuickText(kind, id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
      if (editingId != null) resetForm();
    },
  });

  async function handleDelete(item: EmployeeQuickText) {
    const ok = await confirm({
      title: "Удалить?",
      message: `Удалить «${itemLabel(item)}»?`,
      confirmLabel: "Удалить",
      variant: "danger",
    });
    if (!ok) return;
    deleteMutation.mutate(item.id);
  }

  function handleInsert(item: EmployeeQuickText) {
    onChange(insertQuickTextIntoCompose(value, item.body));
    setOpen(false);
    setManaging(false);
  }

  const busy = saveMutation.isPending || deleteMutation.isPending;

  return (
    <div className="quick-text-picker" ref={rootRef}>
      <button
        type="button"
        className="btn-secondary btn-icon ticket-chat__action-btn"
        disabled={disabled}
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
          if (open) {
            setManaging(false);
            resetForm();
          }
        }}
      >
        <BookText size={18} aria-hidden="true" />
      </button>

      {open ? (
        <div className="quick-text-picker__panel" role="dialog" aria-label={label}>
          <div className="quick-text-picker__header">
            <strong>{managing ? manageLabel : label}</strong>
            <div className="quick-text-picker__header-actions">
              {!managing ? (
                <button type="button" className="btn-secondary btn-sm" onClick={startCreate} disabled={busy}>
                  {manageLabel}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => {
                    setManaging(false);
                    resetForm();
                  }}
                  disabled={busy}
                >
                  К списку
                </button>
              )}
              <button
                type="button"
                className="btn-secondary btn-icon btn-sm"
                aria-label="Закрыть"
                onClick={() => {
                  setOpen(false);
                  setManaging(false);
                  resetForm();
                }}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          </div>

          {managing ? (
            <div className="quick-text-picker__form">
              <label>
                Заголовок
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={120}
                  placeholder="Необязательно"
                  disabled={busy}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.stopPropagation();
                      if (!body.trim() || busy) return;
                      saveMutation.mutate();
                    }
                  }}
                />
              </label>
              <label>
                Текст
                <textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  rows={4}
                  maxLength={4000}
                  required
                  disabled={busy}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      event.stopPropagation();
                      if (!body.trim() || busy) return;
                      saveMutation.mutate();
                    }
                  }}
                />
              </label>
              {formError ? <p className="message error">{formError}</p> : null}
              <div className="quick-text-picker__form-actions">
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  disabled={busy || !body.trim()}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!body.trim()) {
                      setFormError("Введите текст.");
                      return;
                    }
                    saveMutation.mutate();
                  }}
                >
                  {editingId != null ? "Сохранить" : "Добавить"}
                </button>
                {editingId != null ? (
                  <button type="button" className="btn-secondary btn-sm" onClick={resetForm} disabled={busy}>
                    Отмена
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="quick-text-picker__list">
            {listQuery.isLoading ? <p className="muted-copy">Загрузка…</p> : null}
            {!listQuery.isLoading && items.length === 0 ? <p className="muted-copy">{emptyLabel}</p> : null}
            {items.map((item) => (
              <div key={item.id} className="quick-text-picker__item">
                <button
                  type="button"
                  className="quick-text-picker__item-main"
                  disabled={busy}
                  onClick={() => handleInsert(item)}
                  title={item.body}
                >
                  <span className="quick-text-picker__item-title">{itemLabel(item)}</span>
                  {item.title?.trim() ? (
                    <span className="quick-text-picker__item-preview">{item.body}</span>
                  ) : null}
                </button>
                {managing ? (
                  <div className="quick-text-picker__item-actions">
                    <button
                      type="button"
                      className="btn-secondary btn-icon btn-sm"
                      aria-label="Изменить"
                      title="Изменить"
                      disabled={busy}
                      onClick={() => startEdit(item)}
                    >
                      <Pencil size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-icon btn-sm"
                      aria-label="Удалить"
                      title="Удалить"
                      disabled={busy}
                      onClick={() => void handleDelete(item)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          {managing ? (
            <button type="button" className="btn-secondary btn-sm quick-text-picker__add" onClick={startCreate} disabled={busy}>
              <Plus size={14} aria-hidden="true" />
              Новый
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
