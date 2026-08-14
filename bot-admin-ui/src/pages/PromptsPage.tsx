import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { activateAiPrompt, createAiPrompt, deleteAiPrompt, getAiPrompts, saveAiPrompt } from "../api/ai";
import LoadingState from "../components/LoadingState";
import Modal from "../components/Modal";
import { useConfirm } from "../contexts/ConfirmContext";
import { useAuth } from "../hooks/useAuth";
import type { AiPrompt, AiPromptSlug, AiPromptType } from "../lib/types";

const PROMPT_TABS: Array<{ slug: AiPromptSlug; title: string }> = [
  { slug: "customer", title: "Агент поддержки" },
  { slug: "customer_assist", title: "Агент поддержки (сотрудник)" },
  { slug: "kb", title: "База знаний" },
  { slug: "ticket_summary", title: "Сводка обращения" },
];

type PromptEditor = {
  id: number | null;
  type: AiPromptSlug;
  name: string;
  body: string;
};

function preview(body: string, max = 360) {
  const text = String(body || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function copyName(name: string) {
  const base = String(name || "").trim() || "Промпт";
  const suffix = " (копия)";
  if (base.endsWith(suffix)) return base;
  return `${base}${suffix}`.slice(0, 120);
}

export default function PromptsPage() {
  const { hasPermission } = useAuth();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const canEdit = hasPermission("settings_edit");
  const [tab, setTab] = useState<AiPromptSlug>("customer");
  const [editor, setEditor] = useState<PromptEditor | null>(null);
  const [formError, setFormError] = useState("");

  const query = useQuery({
    queryKey: ["ai-prompts"],
    queryFn: getAiPrompts,
  });

  const types = query.data?.types || [];
  const tabs = types.length ? types : PROMPT_TABS;
  const selected: AiPromptType | undefined = useMemo(
    () => types.find((item) => item.slug === tab) || types[0],
    [tab, types],
  );
  const prompts = selected?.prompts || [];

  function invalidatePrompts() {
    return queryClient.invalidateQueries({ queryKey: ["ai-prompts"] });
  }

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!editor) throw new Error("Промпт не выбран.");
      const name = editor.name.trim();
      const body = editor.body.trim();
      if (!name) throw new Error("Введите название промпта.");
      if (!body) throw new Error("Введите текст промпта.");
      if (editor.id) return saveAiPrompt(editor.id, { name, body });
      return createAiPrompt({ type: editor.type, name, body });
    },
    onSuccess: () => {
      setEditor(null);
      void invalidatePrompts();
    },
    onError: (error: Error) => setFormError(error.message),
  });

  const activateMutation = useMutation({
    mutationFn: (prompt: AiPrompt) => activateAiPrompt({ type: prompt.type, prompt_id: prompt.id }),
    onSuccess: () => void invalidatePrompts(),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteAiPrompt,
    onSuccess: () => void invalidatePrompts(),
  });

  function openCreate(source?: AiPrompt) {
    if (!selected) return;
    setEditor({
      id: null,
      type: selected.slug,
      name: source ? copyName(source.name) : "",
      body: source?.body || selected.prompts.find((item) => item.is_default)?.body || "",
    });
    setFormError("");
  }

  function openEdit(prompt: AiPrompt) {
    if (prompt.id == null) return;
    setEditor({
      id: prompt.id,
      type: prompt.type,
      name: prompt.name,
      body: prompt.body,
    });
    setFormError("");
  }

  async function handleActivate(prompt: AiPrompt) {
    if (prompt.is_active) return;
    activateMutation.mutate(prompt);
  }

  async function handleDelete(prompt: AiPrompt) {
    if (prompt.id == null) return;
    const ok = await confirm({
      message: prompt.is_active
        ? `Удалить активный промпт «${prompt.name}»? Будет включён промпт по умолчанию.`
        : `Удалить промпт «${prompt.name}»?`,
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (ok) deleteMutation.mutate(prompt.id);
  }

  return (
    <section className="page page--prompts">
      <section className="card">
        <div className="card-toolbar">
          <div className="role-tabs" role="tablist" aria-label="Типы промптов">
            {tabs.map((item) => (
              <button
                key={item.slug}
                type="button"
                className={`role-tab${(selected?.slug || tab) === item.slug ? " role-tab--active" : ""}`}
                role="tab"
                aria-selected={(selected?.slug || tab) === item.slug}
                onClick={() => setTab(item.slug)}
              >
                {item.title}
              </button>
            ))}
          </div>
          {canEdit && selected ? (
            <div className="card-toolbar-right">
              <button type="button" className="btn-primary" onClick={() => openCreate()}>
                Новый промпт
              </button>
            </div>
          ) : null}
        </div>

        {query.isLoading ? (
          <LoadingState />
        ) : !selected ? (
          <p className="empty-state">Промпты не найдены.</p>
        ) : !prompts.length ? (
          <p className="empty-state">Для этого типа пока нет промптов.</p>
        ) : (
          <ul className="knowledge-list">
            {prompts.map((prompt) => (
              <li
                key={prompt.id ?? `${prompt.type}:default`}
                className={`knowledge-list__item${prompt.is_active ? " knowledge-list__item--active" : ""}`}
              >
                <div className="knowledge-list__title">
                  <strong>{prompt.name}</strong>
                  {prompt.is_active ? <span className="badge badge--ok">Активный</span> : null}
                  {prompt.is_default ? <span className="badge badge--muted">По умолчанию</span> : null}
                </div>
                <p className="prompt-preview">{preview(prompt.body)}</p>
                {canEdit ? (
                  <div className="cell-actions">
                    {!prompt.is_active ? (
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => void handleActivate(prompt)}
                        disabled={activateMutation.isPending}
                      >
                        Сделать активным
                      </button>
                    ) : null}
                    {prompt.id != null ? (
                      <button type="button" className="btn-secondary" onClick={() => openEdit(prompt)}>
                        Изменить
                      </button>
                    ) : null}
                    <button type="button" className="btn-secondary" onClick={() => openCreate(prompt)}>
                      Дублировать
                    </button>
                    {prompt.id != null ? (
                      <button type="button" className="btn-danger" onClick={() => void handleDelete(prompt)}>
                        Удалить
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal
        open={editor != null}
        title={editor?.id ? "Редактирование промпта" : "Новый промпт"}
        onClose={() => setEditor(null)}
        size="wide"
      >
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            setFormError("");
            saveMutation.mutate();
          }}
        >
          <label>
            Название
            <input
              value={editor?.name || ""}
              onChange={(event) => setEditor((current) => (current ? { ...current, name: event.target.value } : current))}
              maxLength={120}
              required
            />
          </label>
          <label>
            Текст
            <textarea
              rows={14}
              value={editor?.body || ""}
              onChange={(event) => setEditor((current) => (current ? { ...current, body: event.target.value } : current))}
              required
            />
          </label>
          {formError ? <p className="message error">{formError}</p> : null}
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setEditor(null)}>
              Отмена
            </button>
            <button type="submit" className="btn-primary" disabled={saveMutation.isPending}>
              Сохранить
            </button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
